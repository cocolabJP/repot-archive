import contextlib
import ftplib
import importlib.util
import io
from pathlib import Path
import posixpath
import ssl
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "2_upload_photos_ftp.py"
SPEC = importlib.util.spec_from_file_location("upload_photos_ftp", SCRIPT)
upload = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = upload
SPEC.loader.exec_module(upload)


class FakeFTP:
    """実サーバーに接続せず、送信結果・公開される名前・失敗時の処理を確認する。"""

    def __init__(self):
        self.directories = {"/": {}, "/repot-archive": {}, "/repot-archive/photo": {}, "/repot-archive/thumb": {}}
        self.current = "/"
        self.sock = None
        self.events = []
        self.fail_transfer = False
        self.bad_size = False
        self.no_mlsd = False
        self.closed = False

    def connect(self, host, port, timeout):
        self.events.append(("connect", host, port))
        self.sock = object()

    def login(self, user, password):
        self.events.append(("login", user))

    def prot_p(self):
        self.events.append(("prot_p",))

    def set_pasv(self, value):
        self.events.append(("pasv", value))

    def cwd(self, name):
        destination = posixpath.normpath(posixpath.join(self.current, name))
        if destination not in self.directories:
            raise ftplib.error_perm("550 Directory not found")
        self.current = destination

    def pwd(self):
        return self.current

    def mkd(self, name):
        self.directories[posixpath.join(self.current, name)] = {}
        self.events.append(("mkd", name))

    def mlsd(self):
        if self.no_mlsd:
            raise ftplib.error_perm("500 MLSD not supported")
        return [(name, {"type": "file"}) for name in self.directories[self.current]]

    def nlst(self):
        return [posixpath.join(self.current, name) for name in self.directories[self.current]]

    def storbinary(self, command, source, blocksize):
        name = command.removeprefix("STOR ")
        self.events.append(("stor", self.current, name))
        self.directories[self.current][name] = source.read()
        if self.fail_transfer:
            raise ftplib.error_temp("426 Transfer failed")

    def size(self, name):
        return len(self.directories[self.current][name]) + int(self.bad_size)

    def rename(self, before, after):
        self.events.append(("rename", before, after))
        files = self.directories[self.current]
        files[after] = files.pop(before)

    def delete(self, name):
        self.events.append(("delete", name))
        self.directories[self.current].pop(name, None)

    def quit(self):
        self.sock = None

    def close(self):
        self.closed = True
        self.sock = None


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for folder in upload.SOURCES.values():
            (self.root / folder).mkdir()
        self.photo = self.root / "archive_photo" / "20261001_new.png"
        self.thumb = self.root / "archive_thumb" / self.photo.name
        self.photo.write_bytes(b"photo bytes")
        self.thumb.write_bytes(b"thumbnail bytes")
        self.config = upload.Config(host="ftp.example.test", user="test-user", password="test-secret")

    def test_patterns_are_combined_and_appledouble_is_excluded(self):
        (self.photo.parent / "20260901_old.png").write_bytes(b"old")
        (self.photo.parent / "._20261001_new.png").write_bytes(b"metadata")
        result = upload.collect_files(["202610*.png", "*.png"], self.root)
        self.assertEqual([p.name for p in result["photo"]], ["20260901_old.png", self.photo.name])
        self.assertEqual(result["thumb"], [self.thumb])
        with self.assertRaises(ValueError):
            upload.collect_files(["../*.png"], self.root)

    def test_default_dry_run_never_connects_and_works_without_credentials(self):
        with patch.object(upload, "DATA_DIR", self.root), patch.dict("os.environ", {}, clear=True), \
                patch.object(ftplib, "FTP_TLS", side_effect=AssertionError("通信禁止")), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(upload.main(["--pattern", "202610*.png"]), 0)
        self.assertIn("接続・アップロードなし", output.getvalue())
        self.assertIn("合計 2 件", output.getvalue())

    def test_config_environment_overrides_ini_and_password_is_not_in_repr(self):
        config_file = self.root / "ftp_upload.ini"
        config_file.write_text("[ftp]\nhost = file-host\nuser = file-user\npassword = 100%#secret\n", encoding="utf8")
        config = upload.load_config(config_file, {"FTP_HOST": "env-host"})
        self.assertEqual(config.host, "env-host")
        self.assertEqual(config.user, "file-user")
        self.assertEqual(config.password, "100%#secret")
        self.assertNotIn(config.password, repr(config))
        config_file.write_text("[ftp]\npassword = hidden-secret\ninvalid line\n", encoding="utf8")
        with self.assertRaises(ValueError) as error:
            upload.load_config(config_file, {})
        self.assertNotIn("hidden-secret", str(error.exception))

    def test_root_env_accepts_account_labels_and_selects_the_matching_server(self):
        project = self.root / "project"
        data = project / "data"
        data.mkdir(parents=True)
        password = "p#ass%word'\"$()"
        (project / ".env").write_text(
            "# 管理画面から転記した情報\nFTP_SERVER: plain.example.test\nFTPS_SERVER: tls.example.test\n"
            "WEBDAV_SERVER: https://unused.example.test/\nFTP_ACCOUNT:\ttest-account\n"
            f"FTP_ACCOUNTパスワード: {password}\n", encoding="utf8")
        with patch.object(upload, "DATA_DIR", data):
            config = upload.load_config(environ={})
            self.assertEqual(config.host, "tls.example.test")
            self.assertEqual(config.user, "test-account")
            self.assertEqual(config.password, password)
            config = upload.load_config(environ={"FTP_PROTOCOL": "ftp"})
            self.assertEqual(config.host, "plain.example.test")
            (data / ".env").write_text("FTP_USER=nearby-user\nFTP_TIMEOUT=90\n", encoding="utf8")
            config = upload.load_config(environ={"FTP_USER": "process-user"})
            self.assertEqual(config.user, "process-user")
            self.assertEqual(config.timeout, 90)

    def test_standard_env_preserves_quoted_passwords_and_never_evaluates_commands(self):
        env = self.root / "test.env"
        env.write_text('export FTP_HOST="tls.example.test" # comment\nFTP_USER=dotenv-user\n'
                       'FTP_PASSWORD="pa\\\"ss\\\\word#%"\n', encoding="utf8")
        config = upload.load_config(env_file=env, environ={})
        self.assertEqual(config.host, "tls.example.test")
        self.assertEqual(config.password, 'pa"ss\\word#%')
        env.write_text("FTP_PASSWORD=$(do_not_execute) # comment\n", encoding="utf8")
        with patch("os.system", side_effect=AssertionError("実行禁止")):
            self.assertEqual(upload.read_env_file(env)["FTP_PASSWORD"], "$(do_not_execute)")
        env.write_text('FTP_PASSWORD="secret-with-bad-quote\n', encoding="utf8")
        with self.assertRaises(ValueError) as error:
            upload.read_env_file(env)
        self.assertNotIn("secret-with-bad-quote", str(error.exception))

    def test_explicit_files_do_not_silently_mix_other_server_credentials(self):
        data = self.root / "project" / "data"
        data.mkdir(parents=True)
        (data.parent / ".env").write_text("FTP_HOST=auto-host\nFTP_USER=auto-user\nFTP_PASSWORD=auto-secret\n", encoding="utf8")
        ini = self.root / "another.ini"
        ini.write_text("[ftp]\nhost=ini-host\nuser=ini-user\npassword=ini-secret\n", encoding="utf8")
        (data / "ftp_upload.ini").write_text("[ftp]\nhost=old-host\nuser=old-user\npassword=old-secret\n", encoding="utf8")
        env = self.root / "another.env"
        env.write_text("FTPS_SERVER=explicit-host\nFTP_PASS=explicit-secret\n", encoding="utf8")
        with patch.object(upload, "DATA_DIR", data):
            self.assertEqual(upload.load_config(ini, environ={}).host, "ini-host")
            selected = upload.load_config(env_file=env, environ={})
            self.assertEqual(selected.host, "explicit-host")
            self.assertEqual(selected.password, "explicit-secret")
            self.assertEqual(selected.user, "")
            merged = upload.load_config(ini, env_file=env, environ={"FTP_HOST": "process-host"})
            self.assertEqual(merged.host, "process-host")
            self.assertEqual(merged.user, "ini-user")

    def test_env_file_cli_dry_run_does_not_connect_or_show_the_password(self):
        env = self.root / "ftp.env"
        env.write_text("FTP_HOST=test.example.test\nFTP_USER=private-account\nFTP_PASSWORD=private-secret\n", encoding="utf8")
        with patch.object(upload, "DATA_DIR", self.root), patch.dict("os.environ", {}, clear=True), \
                patch.object(ftplib, "FTP_TLS", side_effect=AssertionError("通信禁止")), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(upload.main(["--env-file", str(env), "--dry-run"]), 0)
        self.assertNotIn("private-account", output.getvalue())
        self.assertNotIn("private-secret", output.getvalue())

    def test_existing_files_are_preserved_and_both_types_are_uploaded(self):
        ftp = FakeFTP()
        (self.photo.parent / "20261001_existing.png").write_bytes(b"replacement")
        ftp.directories["/repot-archive/photo"]["20261001_existing.png"] = b"original"
        batches = upload.collect_files(["202610*.png"], self.root)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(upload.upload_batches(ftp, batches, self.config), (2, 1))
            self.assertEqual(upload.upload_batches(ftp, batches, self.config), (0, 3))
        self.assertEqual(ftp.directories["/repot-archive/photo"]["20261001_existing.png"], b"original")
        self.assertEqual(ftp.directories["/repot-archive/photo"][self.photo.name], self.photo.read_bytes())
        self.assertEqual(ftp.directories["/repot-archive/thumb"][self.thumb.name], self.thumb.read_bytes())
        self.assertEqual(sum(event[0] == "stor" for event in ftp.events), 2)
        self.assertFalse(any(name.endswith(".tmp") for files in ftp.directories.values() for name in files))

    def test_incomplete_transfer_or_bad_size_never_publishes_the_final_name(self):
        for reason in ("fail_transfer", "bad_size"):
            with self.subTest(reason=reason):
                ftp = FakeFTP()
                ftp.cwd("/repot-archive/photo")
                setattr(ftp, reason, True)
                with self.assertRaises((ftplib.error_temp, RuntimeError)):
                    upload.upload_one(ftp, self.photo)
                self.assertEqual(ftp.directories[ftp.current], {})
                self.assertFalse(any(event[0] == "rename" for event in ftp.events))
                self.assertTrue(all(event[1].startswith(".repot-upload-") for event in ftp.events if event[0] == "delete"))

    def test_listing_fallback_and_permission_errors(self):
        ftp = FakeFTP()
        ftp.cwd("/repot-archive/photo")
        ftp.no_mlsd = True
        ftp.directories[ftp.current]["existing.png"] = b"original"
        self.assertEqual(upload.remote_names(ftp), {"existing.png"})
        with patch.object(ftp, "mlsd", side_effect=ftplib.error_perm("550 Permission denied")):
            with self.assertRaises(ftplib.error_perm):
                upload.remote_names(ftp)
        with patch.object(ftp, "nlst", side_effect=ftplib.error_perm("550 No files found")):
            self.assertEqual(upload.remote_names(ftp), set())

    def test_missing_child_directory_is_created_under_the_existing_base(self):
        ftp = FakeFTP()
        del ftp.directories["/repot-archive/thumb"]
        with contextlib.redirect_stdout(io.StringIO()):
            upload.upload_batches(ftp, upload.collect_files(["*.png"], self.root), self.config)
        events = [event[0] for event in ftp.events]
        self.assertLess(events.index("mkd"), events.index("stor"))
        self.assertIn(self.thumb.name, ftp.directories["/repot-archive/thumb"])

    def test_ftps_verifies_certificates_protects_data_and_closes_on_error(self):
        ftp = FakeFTP()
        with patch.object(ftplib, "FTP_TLS", return_value=ftp) as factory:
            with upload.ftp_session(self.config):
                pass
            context = factory.call_args.kwargs["context"]
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertIn(("prot_p",), ftp.events)
        self.assertIn(("pasv", True), ftp.events)
        self.assertTrue(ftp.closed)
        ftp = FakeFTP()
        with patch.object(ftplib, "FTP_TLS", return_value=ftp), \
                patch.object(ftp, "connect", side_effect=ConnectionRefusedError("refused")):
            with self.assertRaises(ConnectionRefusedError):
                with upload.ftp_session(self.config):
                    self.fail("接続失敗後には進まない")
        self.assertTrue(ftp.closed)

    def test_send_requires_credentials_before_connecting(self):
        with patch.object(upload, "DATA_DIR", self.root), patch.dict("os.environ", {}, clear=True), \
                patch.object(ftplib, "FTP_TLS", side_effect=AssertionError("通信禁止")), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
            self.assertEqual(upload.main(["--send"]), 1)
        self.assertIn("FTP_HOST, FTP_USER", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
