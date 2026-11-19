#!/usr/bin/env python3
"""archive_photo / archive_thumb の未登録画像を FTP / 明示的 FTPS で送る。"""

import argparse
import configparser
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field, replace
import ftplib
import getpass
import os
from pathlib import Path
import posixpath
import re
import ssl
import sys
import uuid


DATA_DIR = Path(__file__).resolve().parent
SOURCES = {"photo": "archive_photo", "thumb": "archive_thumb"}
UNSUPPORTED = {"500", "501", "502", "504"}


@dataclass(frozen=True)
class Config:
    host: str = ""
    user: str = ""
    password: str = field(default="", repr=False)
    remote_dir: str = "/repot-archive"
    protocol: str = "ftps"
    port: int = 21
    timeout: int = 60


def read_env_file(filename):
    """KEY=VALUE と、アカウント情報の KEY: VALUE 形式を値を表示せず読む。"""
    try:
        text = Path(filename).read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError):
        raise ValueError(f".env ファイルを読めません: {filename}") from None
    values = {}
    for number, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*(?:パスワード)?)\s*([=:：])\s*(.*)", line)
        if not match:
            raise ValueError(f"{filename}:{number}: 設定項目は KEY=VALUE または KEY: VALUE で指定してください。")
        key, separator, value = match.groups()
        # 管理画面から転記したコロン形式の値は、# や引用符もそのまま扱う。
        if separator == "=":
            if value.startswith(("'", '"')):
                quote = value[0]
                end = 1
                while end < len(value):
                    if value[end] == "\\":
                        end += 2
                    elif value[end] == quote:
                        break
                    else:
                        end += 1
                if end >= len(value) or (value[end + 1:].strip() and not value[end + 1:].lstrip().startswith("#")):
                    raise ValueError(f"{filename}:{number}: 引用符で囲んだ設定値を確認してください。")
                value = value[1:end]
                escapes = {"\\": "\\", quote: quote}
                if quote == '"':
                    escapes.update({"n": "\n", "r": "\r", "t": "\t"})
                value = re.sub(r"\\(.)", lambda m: escapes.get(m[1], m[0]), value)
            else:
                value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
        values[key.upper()] = value
    return values


def normalize_env_values(values, protocol):
    result = {}
    for key in ("host", "user", "password", "remote_dir", "protocol", "port", "timeout"):
        name = f"FTP_{key.upper()}"
        if name in values:
            result[key] = values[name]
    if "host" not in result:
        names = ("FTPS_SERVER", "FTP_SERVER") if protocol == "ftps" else ("FTP_SERVER", "FTPS_SERVER")
        for name in names:
            if values.get(name):
                result["host"] = values[name]
                break
    if "user" not in result and "FTP_ACCOUNT" in values:
        result["user"] = values["FTP_ACCOUNT"]
    if "password" not in result:
        for name in ("FTP_ACCOUNTパスワード", "FTP_PASS"):
            if name in values:
                result["password"] = values[name]
                break
    return result


def load_config(config_path=None, environ=None, env_file=None):
    environ = os.environ if environ is None else environ
    values = {}
    candidate = Path(config_path) if config_path else DATA_DIR / "ftp_upload.ini"
    if config_path or (env_file is None and candidate.exists()):
        parser = configparser.ConfigParser(interpolation=None)
        try:
            with candidate.open(encoding="utf-8-sig") as source:
                parser.read_file(source)
            values = dict(parser["ftp"])
        except (OSError, configparser.Error, KeyError):
            # パースエラーにパスワード行が含まれる場合があるため、元の例外は表示しない。
            raise ValueError(f"設定ファイルを読めません: {candidate}（[ftp] セクションが必要です）") from None
    # 明示した INI は自動検出 .env と混ぜない。必要な場合は両方を明示指定する。
    if env_file is not None:
        env_paths = [Path(env_file)]
    elif config_path is None:
        env_paths = [p for p in (DATA_DIR.parent / ".env", DATA_DIR / ".env") if p.is_file()]
    else:
        env_paths = []
    layers = [read_env_file(p) for p in env_paths] + [environ]
    protocol = values.get("protocol", "ftps")
    for layer in layers:
        if "FTP_PROTOCOL" in layer:
            protocol = layer["FTP_PROTOCOL"]
    protocol = str(protocol).strip().lower()
    for layer in layers:
        values.update(normalize_env_values(layer, protocol))
    defaults = Config()
    options = {}
    for key in ("host", "user", "password", "remote_dir", "protocol", "port", "timeout"):
        value = values.get(key, getattr(defaults, key))
        if key in {"port", "timeout"}:
            try:
                value = int(value)
            except (ValueError, TypeError):
                raise ValueError(f"FTP_{key.upper()} は整数で指定してください。") from None
        else:
            value = str(value) if key == "password" else str(value).strip()
            if any(char in value for char in "\r\n\x00"):
                raise ValueError(f"FTP_{key.upper()} に改行・NUL は使えません。")
        options[key] = value
    options["protocol"] = protocol
    config = Config(**options)
    if config.protocol not in {"ftp", "ftps"}:
        raise ValueError("FTP_PROTOCOL は ftp または ftps を指定してください。")
    if not 1 <= config.port <= 65535 or config.timeout <= 0:
        raise ValueError("FTP_PORT は 1〜65535、FTP_TIMEOUT は正の秒数を指定してください。")
    if not config.remote_dir or "://" in config.host:
        raise ValueError("ホスト名には URL を使わず、FTP_REMOTE_DIR には送信先ディレクトリを指定してください。")
    return config


def collect_files(patterns, data_dir=None):
    data_dir = DATA_DIR if data_dir is None else data_dir
    for pattern in patterns:
        if not pattern or any(char in pattern for char in "/\\\r\n\x00") or "**" in pattern:
            raise ValueError("--pattern は 202610*.png のようなファイル名のパターンで指定してください。")
    batches = {}
    for remote_name, local_name in SOURCES.items():
        folder = Path(data_dir) / local_name
        if not folder.is_dir():
            raise ValueError(f"画像ディレクトリがありません: {folder}")
        files = sorted({p for pattern in patterns for p in folder.glob(pattern)
                        if p.is_file() and not p.name.startswith("._")})
        if any(any(char in p.name for char in "\r\n\x00") for p in files):
            raise ValueError(f"ファイル名に改行・NUL が含まれています: {folder}")
        batches[remote_name] = files
    return batches


def empty_listing(error):
    message = str(error).lower()
    return message.startswith("550") and any(text in message for text in
                                             ("no files", "no matches", "directory is empty"))


def remote_names(ftp):
    try:
        return {name for name, _ in ftp.mlsd() if name not in {".", ".."}}
    except ftplib.error_perm as error:
        if empty_listing(error):
            return set()
        if str(error)[:3] not in UNSUPPORTED:
            raise
    try:
        return {posixpath.basename(name.rstrip("/")) for name in ftp.nlst()}
    except ftplib.error_perm as error:
        if empty_listing(error):
            return set()
        raise


@contextmanager
def ftp_session(config):
    if config.protocol == "ftps":
        ftp = ftplib.FTP_TLS(context=ssl.create_default_context(), timeout=config.timeout)
    else:
        ftp = ftplib.FTP(timeout=config.timeout)
    try:
        ftp.connect(config.host, config.port, timeout=config.timeout)
        ftp.login(config.user, config.password)
        if config.protocol == "ftps":
            ftp.prot_p()
        ftp.set_pasv(True)
        yield ftp
    finally:
        with suppress(*ftplib.all_errors):
            if ftp.sock is not None:
                ftp.quit()
        ftp.close()


def upload_one(ftp, source):
    """一時名で転送し、完了後に本来のファイル名へ変更する。"""
    temporary = f".repot-upload-{uuid.uuid4().hex}.tmp"
    try:
        with source.open("rb") as image:
            before = os.fstat(image.fileno())
            ftp.storbinary(f"STOR {temporary}", image, blocksize=64 * 1024)
            after = os.fstat(image.fileno())
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise RuntimeError(f"転送中にローカル画像が変更されました: {source.name}")
        try:
            remote_size = ftp.size(temporary)
        except ftplib.error_perm as error:
            if str(error)[:3] not in UNSUPPORTED:
                raise
            remote_size = None
        if remote_size is not None and remote_size != before.st_size:
            raise RuntimeError(f"転送後のファイルサイズが一致しません: {source.name}")
        ftp.rename(temporary, source.name)
    except (Exception, KeyboardInterrupt):
        # この実行が作った一時ファイルだけを片付ける。既存の画像は削除しない。
        with suppress(*ftplib.all_errors):
            ftp.delete(temporary)
        raise


def upload_batches(ftp, batches, config, verbose=False):
    ftp.cwd(config.remote_dir)
    base_dir = ftp.pwd()
    destinations = {}
    # 両方の保存先と一覧を確認してから、最初の画像の転送を始める。
    for name, files in batches.items():
        if not files:
            continue
        ftp.cwd(base_dir)
        try:
            ftp.cwd(name)
        except ftplib.error_perm as error:
            if not str(error).startswith("550"):
                raise
            ftp.mkd(name)
            ftp.cwd(name)
        destinations[name] = (ftp.pwd(), remote_names(ftp))

    uploaded = skipped = 0
    try:
        for name, files in batches.items():
            if not files:
                continue
            directory, existing = destinations[name]
            ftp.cwd(directory)
            for source in files:
                if source.name in existing:
                    skipped += 1
                    if verbose:
                        print(f"SKIP {name}/{source.name}")
                    continue
                upload_one(ftp, source)
                existing.add(source.name)
                uploaded += 1
                print(f"UPLOAD {name}/{source.name}", flush=True)
    finally:
        print(f"送信 {uploaded} 件 / 既存のためスキップ {skipped} 件", flush=True)
    return uploaded, skipped


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pattern", action="append", help="対象ファイル名。複数指定可。既定値: 20*.png")
    parser.add_argument("--config", type=Path, help="接続設定 INI。省略時: このスクリプトと同じ場所の ftp_upload.ini")
    parser.add_argument("--env-file", type=Path, help="接続情報の .env。省略時はリポジトリ直下と data/.env を自動検出")
    parser.add_argument("--verbose", action="store_true", help="対象ファイル・スキップしたファイルをすべて表示")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--send", action="store_true", help="実際に接続して送信する")
    mode.add_argument("--dry-run", action="store_true", help="接続せず送信候補だけ確認する（既定動作）")
    args = parser.parse_args(argv)
    config = None
    try:
        config = load_config(args.config, env_file=args.env_file)
        batches = collect_files(args.pattern or ["20*.png"])
        count = sum(len(files) for files in batches.values())
        if not count:
            raise ValueError("パターンに一致する画像がありません。")
        size = sum(p.stat().st_size for files in batches.values() for p in files)
        print("SEND" if args.send else "DRY RUN（接続・アップロードなし）")
        print(f"送信先: {config.protocol}://{config.host or '(FTP_HOST 未設定)'}:{config.port}{config.remote_dir}")
        for name, files in batches.items():
            print(f"{SOURCES[name]} → {name}/: {len(files)} 件")
        print(f"合計 {count} 件 / {size / 1024 / 1024:.2f} MiB")
        if not args.send:
            for name, files in batches.items():
                for source in (files if args.verbose else files[:10]):
                    print(f"候補 {name}/{source.name}")
                if not args.verbose and len(files) > 10:
                    print(f"  ほか {len(files) - 10} 件（--verbose ですべて表示）")
            print("既存ファイルの確認・スキップは --send 時に行います。")
            return 0
        missing = [key for key in ("host", "user") if not getattr(config, key)]
        if missing:
            raise ValueError(f"接続情報が未設定です: {', '.join('FTP_' + key.upper() for key in missing)}")
        if not config.password:
            if not sys.stdin.isatty():
                raise ValueError("FTP_PASSWORD を環境変数または設定ファイルに設定してください。")
            config = replace(config, password=getpass.getpass("FTP パスワード: "))
            if not config.password:
                raise ValueError("FTP パスワードが空です。")
        with ftp_session(config) as ftp:
            upload_batches(ftp, batches, config, args.verbose)
        return 0
    except KeyboardInterrupt:
        print("中断しました。送信済みの画像はサーバーに残ります。", file=sys.stderr)
        return 130
    except (ValueError, RuntimeError, *ftplib.all_errors) as error:
        message = str(error)
        if config and config.password:
            message = message.replace(config.password, "***")
        print(f"実行失敗: {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
