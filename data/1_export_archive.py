import pandas as pd
import json
import urllib.request
import shutil
import logging
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from PIL import Image, ImageOps
from concurrent.futures import ThreadPoolExecutor, as_completed

### v1 データ（変換済み）と v2 データを統合した、アーカイブ生成コード（高速化版）

# -----------------------------
# 設定
# -----------------------------
TARGET_PERIOD_FROM = "20260617"
TARGET_PERIOD_TO   = "20261231"

ARCHIVE_LIST_CSV = Path("archive_list.csv")
V1_TSV_DIR = Path("v1_tsv")
V2_TSV_DIR = Path("v2_tsv")
V1_PHOTO_DIR = Path("v1_photo")
V2_PHOTO_DIR = Path("v2_photo")
ARCHIVE_PHOTO_DIR = Path("archive_photo")
ARCHIVE_THUMB_DIR = Path("archive_thumb")
DOCS_ARCHIVES_DIR = Path("../docs/data/archives")
DOCS_ARCHIVES_JSON_DIR = Path("../docs/data/json")
DOCS_ARCHIVES_JS = Path("../docs/data/archives.js")

V2_TSV_BASE_URL = "https://repot.sokendo.studio/static/archive"
V2_PHOTO_BASE_URL = "https://repot.sokendo.studio/uploads/original"

MAX_IMAGE_SIZE = (1920, 1920)
THUMB_SIZE = (480, 480)
COMPRESS_THRESHOLD = 3 * 1024 * 1024  # 3MB
DOWNLOAD_WORKERS = 8

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)

# -----------------------------
# ユーティリティ
# -----------------------------
def ensure_dirs():
    for d in [
        V2_TSV_DIR,
        V2_PHOTO_DIR,
        ARCHIVE_PHOTO_DIR,
        ARCHIVE_THUMB_DIR,
        DOCS_ARCHIVES_DIR,
        DOCS_ARCHIVES_JSON_DIR,
    ]:
        d.mkdir(parents=True, exist_ok=True)


def clear_old_archive_files(keep_slugs):
    for p in DOCS_ARCHIVES_DIR.glob("*.js"):
        if p.stem not in keep_slugs:
            p.unlink()
    for p in DOCS_ARCHIVES_JSON_DIR.glob("*.json"):
        if p.stem not in keep_slugs:
            p.unlink()


def is_target_period(filename: str) -> bool:
    # filename の先頭8文字が YYYYMMDD である前提
    d = filename[:8]
    return TARGET_PERIOD_FROM < d < TARGET_PERIOD_TO


class ImageReadError(RuntimeError):
    """未取得・破損などにより元画像を読み込めない。"""


@contextmanager
def staged_file(destination: Path):
    """同じディレクトリに一時出力し、呼び出し側が成功時だけreplaceする。"""
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix=f".{destination.stem}-", suffix=destination.suffix,
                                     dir=destination.parent, delete=False) as handle:
        temporary = Path(handle.name)
    try:
        temporary.chmod(destination.stat().st_mode & 0o777 if destination.exists() else 0o644)
        yield temporary
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def decoded_image(path: Path):
    image = None
    try:
        image = Image.open(path)
        image.load()  # JPEGのヘッダーだけでなく、画素の末尾まで検証する。
    except Exception as error:
        if image is not None:
            image.close()
        raise ImageReadError(f"cannot read image: {path.name} ({error})") from error
    try:
        yield image
    finally:
        image.close()


def validate_generated_image(path: Path):
    try:
        with decoded_image(path):
            pass
    except ImageReadError as error:
        raise RuntimeError(f"generated image is invalid: {path.name} ({error})") from error


def download_file(url: str, dest_path: Path, overwrite: bool = False, timeout: int = 30,
                  *, validate_image: bool = False, retries: int = 3):
    if dest_path.exists() and not overwrite:
        if not validate_image:
            return
        try:
            with decoded_image(dest_path):
                return
        except ImageReadError:
            logging.warning("invalid cached image; download again: %s", dest_path.name)

    for attempt in range(1, retries + 1):
        try:
            with staged_file(dest_path) as temporary:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=timeout) as response, temporary.open("wb") as output:
                    expected = response.headers.get("Content-Length")
                    shutil.copyfileobj(response, output)
                actual = temporary.stat().st_size
                if expected is not None and actual != int(expected):
                    raise RuntimeError(f"incomplete download: expected {expected} bytes, received {actual}")
                if validate_image:
                    with decoded_image(temporary):
                        pass
                temporary.replace(dest_path)
            return
        except Exception as error:
            if attempt == retries:
                raise RuntimeError(f"download failed: {url} -> {dest_path} ({error})") from error
            logging.warning("download retry %d/%d: %s (%s)", attempt, retries, dest_path.name, error)
            time.sleep(1)


def copy_if_newer(src: Path, dst_dir: Path) -> Path:
    dst = dst_dir / src.name
    if not dst.exists() or src.stat().st_mtime > dst.stat().st_mtime:
        with staged_file(dst) as temporary:
            shutil.copy2(src, temporary)
            temporary.replace(dst)
    return dst


def compress_photo_external(photo_path: Path):
    # 外部コマンドに依存するので、無くても処理続行
    import subprocess

    ext = photo_path.suffix.lower()

    try:
        if ext in [".jpg", ".jpeg"]:
            cmd = [
                "jpegoptim",
                "--max=80",
                "--strip-all",
                "--all-progressive",
                str(photo_path)
            ]
            result = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            if result.returncode != 0:
                logging.warning("jpegoptim failed: %s", result.stderr.strip())

        elif ext == ".png":
            cmd = [
                "pngquant",
                "--quality=65-80",
                "--ext", ".png",
                "--force",
                str(photo_path)
            ]
            result = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            if result.returncode != 0:
                logging.warning("pngquant failed: %s", result.stderr.strip())

    except FileNotFoundError:
        logging.warning("external compressor not found. skipped: %s", photo_path.name)
    except Exception as e:
        logging.warning("external compression error: %s (%s)", photo_path.name, e)


def process_photo(photo_path: Path, thumbnail_path: Path, *, source_path: Path = None):
    """
    画像の
    - 拡張子とフォーマットの整合性補正
    - リサイズ
    - サムネイル作成
    - 必要時の外部圧縮
    をまとめて行う。読込・保存の失敗は呼び出し側へ通知し、既存の出力は保護する。
    """
    source_path = photo_path if source_path is None else source_path
    ext = photo_path.suffix.lower()
    with decoded_image(source_path) as original:
        output_format = "PNG" if ext == ".png" else "JPEG" if ext in {".jpg", ".jpeg"} else original.format
        oriented = original.getexif().get(274, 1) != 1
        img = ImageOps.exif_transpose(original) if oriented else original
        before_size = img.size
        img.thumbnail(MAX_IMAGE_SIZE)
        changed = original.format != output_format or oriented or img.size != before_size
        if output_format == "JPEG" and img.mode != "RGB":
            img = img.convert("RGB")
            changed = True
        save_options = {"optimize": True} if output_format == "PNG" else {"quality": 80, "optimize": True, "progressive": True}
        needs_compression = source_path.stat().st_size >= COMPRESS_THRESHOLD or changed
        rewrite_photo = source_path != photo_path or changed or needs_compression
        with staged_file(photo_path) as prepared_photo, staged_file(thumbnail_path) as prepared_thumb:
            if rewrite_photo:
                if changed:
                    img.save(prepared_photo, format=output_format, **save_options)
                else:
                    shutil.copy2(source_path, prepared_photo)
                if needs_compression:
                    compress_photo_external(prepared_photo)
                validate_generated_image(prepared_photo)
            with img.copy() as thumb:
                thumb.thumbnail(THUMB_SIZE)
                thumb.save(prepared_thumb, format=output_format, **save_options)
            validate_generated_image(prepared_thumb)
            # 両方の生成・検証が終わってから、本来のファイル名へ切り替える。
            if rewrite_photo:
                prepared_photo.replace(photo_path)
            prepared_thumb.replace(thumbnail_path)
    return True


def prepare_archive_photo(source_path: Path, *, force: bool = False):
    photo = ARCHIVE_PHOTO_DIR / source_path.name
    thumb = ARCHIVE_THUMB_DIR / source_path.name
    if not source_path.is_file():
        raise ImageReadError(f"photo not found: {source_path}")
    newer = not photo.exists() or source_path.stat().st_mtime > photo.stat().st_mtime
    if force or newer or is_target_period(source_path.name) or not thumb.is_file():
        process_photo(photo, thumb, source_path=source_path if force or newer else photo)
    return photo


def prepare_v2_photo(filename: str):
    source = V2_PHOTO_DIR / filename
    url = f"{V2_PHOTO_BASE_URL}/{filename}"
    if not source.is_file():
        download_file(url, source, validate_image=True)
    try:
        return prepare_archive_photo(source)
    except ImageReadError:
        # アーカイブだけが壊れている場合は、保存済みの元画像から復旧する。
        try:
            return prepare_archive_photo(source, force=True)
        except ImageReadError:
            logging.warning("broken source; re-download original: %s", filename)
            download_file(url, source, overwrite=True, validate_image=True)
            return prepare_archive_photo(source, force=True)


def load_tsv(path: Path):
    if not path.exists():
        return None
    try:
        return pd.read_csv(path, sep="\t")
    except Exception as e:
        logging.error("failed to read tsv: %s (%s)", path, e)
        return None


def concat_existing_dfs(*dfs):
    valid = [df for df in dfs if df is not None]
    if not valid:
        return None
    return pd.concat(valid, ignore_index=True)


def transform_archive_dataframe(df_archive: pd.DataFrame, current_hashtag_name: str) -> pd.DataFrame:
    df_archive = df_archive.sort_values("timestamp", ascending=False).reset_index(drop=True)

    filtered_hashtags = []
    caution_flags = []

    for row in df_archive.itertuples(index=False):
        raw = row.hashtag_names if pd.notna(row.hashtag_names) else ""
        tags = raw.split(";") if raw else []

        caution = "利用上の注意" in tags
        tags = [h for h in tags if h not in {current_hashtag_name, "利用上の注意"}]

        filtered_hashtags.append(tags)
        caution_flags.append(caution)

    df_archive["hashtag_names"] = filtered_hashtags
    df_archive["caution_flag"] = caution_flags
    return df_archive


def write_archive_js(slug: str, json_archive: str):
    out_path = DOCS_ARCHIVES_DIR / f"{slug}.js"
    with staged_file(out_path) as temporary:
        temporary.write_text(
            f"const archive_{slug} = {json_archive};\n"
            f"export default archive_{slug};", encoding="utf-8"
        )
        temporary.replace(out_path)


def write_archive_json(slug: str, json_archive: str):
    out_path = DOCS_ARCHIVES_JSON_DIR / f"{slug}.json"
    with staged_file(out_path) as temporary:
        temporary.write_text(json_archive + "\n", encoding="utf-8")
        temporary.replace(out_path)


def predownload_v2_photos(df_v2: pd.DataFrame):
    jobs = []
    for row in df_v2.itertuples(index=False):
        filename = row.filename
        local_path = V2_PHOTO_DIR / filename
        if not local_path.exists():
            url = f"{V2_PHOTO_BASE_URL}/{filename}"
            jobs.append((url, local_path, filename))

    if not jobs:
        return {}

    logging.info("start parallel download: %d photos", len(jobs))

    failures = {}
    with ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as executor:
        future_map = {
            executor.submit(download_file, url, path, validate_image=True): (filename, path)
            for url, path, filename in jobs
        }

        for future in as_completed(future_map):
            filename, path = future_map[future]
            try:
                future.result()
            except Exception as e:
                failures[filename] = str(e)
                logging.error("photo download failed: %s (%s)", filename, e)
    return failures


# -----------------------------
# メイン処理
# -----------------------------
def main():
    ensure_dirs()

    df_hashtags = pd.read_csv(ARCHIVE_LIST_CSV)
    logging.info("loaded archive list: %d rows", len(df_hashtags))

    js_import_lines = []
    archive_list_entries = []
    archive_meta = {}
    failures = {}

    for row in df_hashtags.itertuples(index=False):
        logging.info("========== [%s] ==========", row.slug)

        df_v1 = None
        df_v2 = None
        dataset_failed = False

        # ------------ v1
        if row.v1 != -1:
            target_tsv = V1_TSV_DIR / f"{row.v1}.tsv"
            logging.info("[v1] load tsv: %s", target_tsv)
            df_v1 = load_tsv(target_tsv)
            if df_v1 is None:
                failures[str(target_tsv)] = "TSVを読み込めません。"
                dataset_failed = True

            if df_v1 is not None:
                total = len(df_v1)
                for i, df_row in enumerate(df_v1.itertuples(index=False), 1):
                    filename = df_row.filename
                    src_path = V1_PHOTO_DIR / filename

                    if not src_path.exists():
                        failures[filename] = f"元画像がありません: {src_path}"
                        dataset_failed = True
                        logging.error("[v1] photo not found: %s", src_path)
                        continue

                    try:
                        prepare_archive_photo(src_path)
                    except Exception as error:
                        failures[filename] = str(error)
                        dataset_failed = True
                        logging.error("[v1] image processing failed: %s (%s)", filename, error)

                    if i % 100 == 0 or i == total:
                        logging.info("[v1] %s progress: %d/%d", target_tsv.name, i, total)

        # ------------ v2
        if row.v2 != -1:
            target_tsv = V2_TSV_DIR / f"{row.v2}.tsv"
            remote_tsv_url = f"{V2_TSV_BASE_URL}/{row.v2}.tsv"

            logging.info("[v2] download tsv: %s", remote_tsv_url)
            try:
                download_file(remote_tsv_url, target_tsv, overwrite=True)
            except Exception as e:
                logging.error("[v2] tsv download failed: %s (%s)", target_tsv, e)

            logging.info("[v2] load tsv: %s", target_tsv)
            df_v2 = load_tsv(target_tsv)
            if df_v2 is None:
                failures[str(target_tsv)] = "TSVを読み込めません。"
                dataset_failed = True

            if df_v2 is not None:
                download_failures = predownload_v2_photos(df_v2)

                total = len(df_v2)
                for i, df_row in enumerate(df_v2.itertuples(index=False), 1):
                    filename = df_row.filename
                    src_path = V2_PHOTO_DIR / filename

                    if not src_path.exists():
                        failures[filename] = download_failures.get(filename, f"元画像がありません: {src_path}")
                        dataset_failed = True
                        logging.error("[v2] photo not found after download: %s", src_path)
                        continue

                    try:
                        prepare_v2_photo(filename)
                    except Exception as error:
                        failures[filename] = str(error)
                        dataset_failed = True
                        logging.error("[v2] image processing failed: %s (%s)", filename, error)

                    if i % 100 == 0 or i == total:
                        logging.info("[v2] %s progress: %d/%d", target_tsv.name, i, total)

        if dataset_failed:
            logging.error("[%s] 出力を更新しません。画像・TSVのエラーを確認してください。", row.slug)
            continue

        # ------------ concat v1 and v2
        df_archive = concat_existing_dfs(df_v1, df_v2)

        if df_archive is not None and not df_archive.empty:
            df_archive = transform_archive_dataframe(df_archive, row.name)
            json_archive = df_archive.to_json(orient="records", force_ascii=False)

            write_archive_js(row.slug, json_archive)
            write_archive_json(row.slug, json_archive)

            archive_meta[row.slug] = {
                "name": row.name,
                "icon": {
                    "name": row.icon_name,
                    "size": [row.icon_size_x, row.icon_size_y],
                    "anchor": [row.icon_anchor_x, row.icon_anchor_y],
                    "popup": [row.popup_x, row.popup_y]
                }
            }

            js_import_lines.append(f'import archive_{row.slug} from "./archives/{row.slug}.js"')
            archive_list_entries.append(f'"{row.slug}": archive_{row.slug}')

        logging.info("done: %s", row.slug)

    if failures:
        logging.error("アーカイブ生成に失敗しました（%d件）。既存の一覧と未更新データは保持します。", len(failures))
        for filename, error in sorted(failures.items()):
            logging.error("FAILED %s: %s", filename, error)
        return 1

    # 統合JSは全データセットの処理が成功したときだけ切り替える。
    with staged_file(DOCS_ARCHIVES_JS) as temporary:
        temporary.write_text(
            "\n".join(js_import_lines) + "\n"
            + "export const HASHTAG_LIST = "
            + json.dumps(archive_meta, ensure_ascii=False)
            + ";\n"
            + "export default HASHTAG_LIST;\n"
            + "export const ARCHIVES = {"
            + ",".join(archive_list_entries)
            + "};", encoding="utf-8"
        )
        temporary.replace(DOCS_ARCHIVES_JS)

    clear_old_archive_files(archive_meta)

    logging.info("all done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
