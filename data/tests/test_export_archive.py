import io
import importlib.util
import json
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

import pandas as pd
from PIL import Image


SCRIPT = Path(__file__).resolve().parents[1] / "1_export_archive.py"
SPEC = importlib.util.spec_from_file_location("export_archive", SCRIPT)
export = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(export)


def jpeg(size=(80, 40), orientation=None):
    output = io.BytesIO()
    options = {}
    if orientation:
        exif = Image.Exif()
        exif[274] = orientation
        options["exif"] = exif
    with Image.new("RGB", size, "#345678") as image:
        image.save(output, format="JPEG", **options)
    return output.getvalue()


class Response(io.BytesIO):
    def __init__(self, data, expected=None):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data) if expected is None else expected)}


class ExportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        settings = {name: self.root / name for name in (
            "V1_TSV_DIR", "V2_TSV_DIR", "V1_PHOTO_DIR", "V2_PHOTO_DIR",
            "ARCHIVE_PHOTO_DIR", "ARCHIVE_THUMB_DIR", "DOCS_ARCHIVES_DIR", "DOCS_ARCHIVES_JSON_DIR",
        )}
        settings["DOCS_ARCHIVES_JS"] = self.root / "archives.js"
        self.settings = patch.multiple(export, **settings)
        self.settings.start()
        self.addCleanup(self.settings.stop)
        export.ensure_dirs()
        export.V1_PHOTO_DIR.mkdir()
        self.sleep = patch.object(export.time, "sleep")
        self.sleep.start()
        self.addCleanup(self.sleep.stop)
        self.compress = patch.object(export, "compress_photo_external")
        self.compress.start()
        self.addCleanup(self.compress.stop)
        self.filename = "20260919125557_9cb93.png"
        self.source = export.V2_PHOTO_DIR / self.filename
        self.photo = export.ARCHIVE_PHOTO_DIR / self.filename
        self.thumb = export.ARCHIVE_THUMB_DIR / self.filename

    def assert_no_temporary_files(self):
        self.assertEqual([p for p in self.root.rglob(".*") if p.is_file()], [])

    def test_short_download_is_retried_and_only_complete_valid_image_is_published(self):
        data = jpeg()
        self.source.write_bytes(b"existing cache")
        with patch.object(export.urllib.request, "urlopen", side_effect=[Response(data[:30], len(data)), Response(data)]) as request:
            export.download_file("https://example.test/photo", self.source, overwrite=True, validate_image=True)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(self.source.read_bytes(), data)
        self.assert_no_temporary_files()

    def test_interrupted_download_preserves_old_file_and_removes_partial_output(self):
        class Interrupted(Response):
            def read(self, count=-1):
                if self.tell():
                    raise ConnectionResetError("connection lost")
                return super().read(12)

        self.source.write_bytes(b"existing good cache")
        with patch.object(export.urllib.request, "urlopen", side_effect=lambda *a, **kw: Interrupted(jpeg())):
            with self.assertRaisesRegex(RuntimeError, "download failed"):
                export.download_file("https://example.test/photo", self.source, overwrite=True, retries=2)
        self.assertEqual(self.source.read_bytes(), b"existing good cache")
        self.assert_no_temporary_files()

    def test_truncated_cached_jpeg_is_downloaded_again(self):
        data = jpeg()
        self.source.write_bytes(data[:-20])
        with self.assertRaises(export.ImageReadError), export.decoded_image(self.source):
            pass
        with patch.object(export.urllib.request, "urlopen", return_value=Response(data)):
            export.download_file("https://example.test/photo", self.source, validate_image=True)
        self.assertEqual(self.source.read_bytes(), data)

    def test_invalid_download_with_complete_length_is_not_cached(self):
        with patch.object(export.urllib.request, "urlopen", side_effect=lambda *a, **kw: Response(b"not an image")) as request:
            with self.assertRaisesRegex(RuntimeError, "download failed"):
                export.download_file("https://example.test/photo", self.source, validate_image=True)
        self.assertEqual(request.call_count, 3)
        self.assertFalse(self.source.exists())
        self.assert_no_temporary_files()

    def test_conversion_and_thumbnail_are_valid_png_and_source_is_preserved(self):
        data = jpeg(size=(2400, 1200))
        self.source.write_bytes(data)
        export.process_photo(self.photo, self.thumb, source_path=self.source)
        self.assertEqual(self.source.read_bytes(), data)
        for path, size in ((self.photo, (1920, 960)), (self.thumb, (480, 240))):
            with Image.open(path) as image:
                image.load()
                self.assertEqual((image.format, image.size), ("PNG", size))
        self.assert_no_temporary_files()

    def test_exif_orientation_is_applied_before_saving_png(self):
        self.source.write_bytes(jpeg(orientation=6))
        export.process_photo(self.photo, self.thumb, source_path=self.source)
        with Image.open(self.thumb) as image:
            self.assertEqual(image.size, (40, 80))
            self.assertIsNone(image.getexif().get(274))

    def test_save_failure_keeps_both_existing_outputs(self):
        self.source.write_bytes(jpeg())
        self.photo.write_bytes(b"existing photo")
        self.thumb.write_bytes(b"existing thumbnail")
        with patch.object(Image.Image, "save", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                export.process_photo(self.photo, self.thumb, source_path=self.source)
        self.assertEqual(self.photo.read_bytes(), b"existing photo")
        self.assertEqual(self.thumb.read_bytes(), b"existing thumbnail")
        self.assert_no_temporary_files()

    def test_broken_source_and_archive_are_recovered_by_downloading_original(self):
        data = jpeg()
        self.source.write_bytes(data[:-20])
        self.photo.write_bytes(data[:-20])
        os.utime(self.source, (1, 1))
        with patch.object(export.urllib.request, "urlopen", return_value=Response(data)) as request:
            export.prepare_v2_photo(self.filename)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(self.source.read_bytes(), data)
        with export.decoded_image(self.thumb) as image:
            self.assertEqual(image.format, "PNG")

    def test_only_broken_archive_is_rebuilt_without_network(self):
        self.source.write_bytes(jpeg())
        self.photo.write_bytes(b"broken archive")
        os.utime(self.source, (1, 1))
        with patch.object(export.urllib.request, "urlopen", side_effect=AssertionError("network must not be used")):
            export.prepare_v2_photo(self.filename)
        with export.decoded_image(self.photo) as image:
            self.assertEqual(image.size, (80, 40))

    def test_failed_source_recovery_preserves_good_existing_outputs(self):
        self.source.write_bytes(jpeg()[:-20])
        self.photo.write_bytes(jpeg())
        self.thumb.write_bytes(jpeg(size=(40, 20)))
        previous = (self.photo.read_bytes(), self.thumb.read_bytes())
        os.utime(self.photo, (1, 1))
        with patch.object(export.urllib.request, "urlopen", side_effect=ConnectionError("offline")):
            with self.assertRaisesRegex(RuntimeError, "download failed"):
                export.prepare_v2_photo(self.filename)
        self.assertEqual((self.photo.read_bytes(), self.thumb.read_bytes()), previous)
        self.assert_no_temporary_files()

    def test_main_reports_failures_and_keeps_existing_dataset_and_index(self):
        (export.DOCS_ARCHIVES_DIR / "fish.js").write_text("previous dataset")
        (export.DOCS_ARCHIVES_DIR / "old.js").write_text("previous other dataset")
        export.DOCS_ARCHIVES_JS.write_text("previous index")
        tags = pd.DataFrame([{"slug": "fish", "v1": 1, "v2": -1}])
        rows = pd.DataFrame([{"filename": self.filename}])
        with patch.object(export.pd, "read_csv", return_value=tags), patch.object(export, "load_tsv", return_value=rows), self.assertLogs(level="ERROR") as logs:
            self.assertEqual(export.main(), 1)
        self.assertTrue(any(self.filename in message for message in logs.output))
        self.assertEqual((export.DOCS_ARCHIVES_DIR / "fish.js").read_text(), "previous dataset")
        self.assertTrue((export.DOCS_ARCHIVES_DIR / "old.js").exists())
        self.assertEqual(export.DOCS_ARCHIVES_JS.read_text(), "previous index")

    def test_bad_generated_output_does_not_trigger_a_source_redownload(self):
        self.source.write_bytes(jpeg())
        with patch.object(export, "compress_photo_external", side_effect=lambda path: path.write_bytes(b"corrupt output")), \
                patch.object(export.urllib.request, "urlopen", side_effect=AssertionError("valid source must not be downloaded")):
            with self.assertRaisesRegex(RuntimeError, "generated image is invalid"):
                export.prepare_v2_photo(self.filename)
        self.assertFalse(self.photo.exists())
        self.assertFalse(self.thumb.exists())
        self.assert_no_temporary_files()

    def test_successful_main_updates_dataset_and_removes_obsolete_files_only_after_success(self):
        (export.V1_PHOTO_DIR / self.filename).write_bytes(jpeg())
        (export.DOCS_ARCHIVES_DIR / "old.js").write_text("obsolete dataset")
        export.DOCS_ARCHIVES_JS.write_text("previous index")
        tags = pd.DataFrame([{"slug": "fish", "name": "魚", "v1": 1, "v2": -1,
                              "icon_name": "fish", "icon_size_x": 40, "icon_size_y": 40,
                              "icon_anchor_x": 20, "icon_anchor_y": 20, "popup_x": 0, "popup_y": 0}])
        rows = pd.DataFrame([{"filename": self.filename, "timestamp": 1790000000, "hashtag_names": "魚;海"}])
        with patch.object(export.pd, "read_csv", return_value=tags), patch.object(export, "load_tsv", return_value=rows):
            self.assertEqual(export.main(), 0)
        exported = json.loads((export.DOCS_ARCHIVES_JSON_DIR / "fish.json").read_text())
        self.assertEqual(exported[0]["filename"], self.filename)
        self.assertEqual(exported[0]["hashtag_names"], ["海"])
        self.assertIn('"fish"', export.DOCS_ARCHIVES_JS.read_text())
        self.assertFalse((export.DOCS_ARCHIVES_DIR / "old.js").exists())
        self.assertTrue(self.thumb.is_file())
        self.assert_no_temporary_files()


if __name__ == "__main__":
    unittest.main()
