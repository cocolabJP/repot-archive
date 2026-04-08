import pandas as pd
import json
import urllib.request
import shutil
import logging
from pathlib import Path
from PIL import Image, UnidentifiedImageError
from concurrent.futures import ThreadPoolExecutor, as_completed

### v1 データ（変換済み）と v2 データを統合した、アーカイブ生成コード（高速化版）

# -----------------------------
# 設定
# -----------------------------
TARGET_PERIOD_FROM = "20260404"
TARGET_PERIOD_TO   = "20261231"

ARCHIVE_LIST_CSV = Path("archive_list.csv")
V1_TSV_DIR = Path("v1_tsv")
V2_TSV_DIR = Path("v2_tsv")
V1_PHOTO_DIR = Path("v1_photo")
V2_PHOTO_DIR = Path("v2_photo")
ARCHIVE_PHOTO_DIR = Path("archive_photo")
ARCHIVE_THUMB_DIR = Path("archive_thumb")
DOCS_ARCHIVES_DIR = Path("../docs/data/archives")
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
    for d in [V2_TSV_DIR, V2_PHOTO_DIR, ARCHIVE_PHOTO_DIR, ARCHIVE_THUMB_DIR, DOCS_ARCHIVES_DIR]:
        d.mkdir(parents=True, exist_ok=True)


def clear_old_archive_js():
    for p in DOCS_ARCHIVES_DIR.glob("*.js"):
        p.unlink()


def is_target_period(filename: str) -> bool:
    # filename の先頭8文字が YYYYMMDD である前提
    d = filename[:8]
    return TARGET_PERIOD_FROM < d < TARGET_PERIOD_TO


def download_file(url: str, dest_path: Path, overwrite: bool = False, timeout: int = 30):
    if dest_path.exists() and not overwrite:
        return

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as response, open(dest_path, "wb") as f:
            shutil.copyfileobj(response, f)
    except Exception as e:
        raise RuntimeError(f"download failed: {url} -> {dest_path} ({e})")


def copy_if_newer(src: Path, dst_dir: Path) -> Path:
    dst = dst_dir / src.name
    if not dst.exists() or src.stat().st_mtime > dst.stat().st_mtime:
        shutil.copy2(src, dst)
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


def process_photo(photo_path: Path, thumbnail_path: Path):
    """
    画像の
    - 拡張子とフォーマットの整合性補正
    - リサイズ
    - サムネイル作成
    - 必要時の外部圧縮
    を1回のopenでまとめて行う
    """
    if not photo_path.exists():
        logging.warning("photo not found: %s", photo_path)
        return

    ext = photo_path.suffix.lower()
    size_before = photo_path.stat().st_size
    need_external_compress = size_before >= COMPRESS_THRESHOLD

    try:
        with Image.open(photo_path) as img:
            img.load()

            original_format = (img.format or "").upper()
            if original_format == "PNG":
                real_fmt = ".png"
            elif original_format == "JPEG":
                real_fmt = ".jpg"
            else:
                real_fmt = ext

            changed = False

            # フォーマット補正（拡張子ではなく実体フォーマット基準で保存）
            if ext != real_fmt:
                logging.info("format mismatch: %s ext=%s real=%s", photo_path.name, ext, real_fmt)
                if real_fmt == ".png":
                    img.save(photo_path, format="PNG", optimize=True)
                    changed = True
                elif real_fmt in [".jpg", ".jpeg"]:
                    img = img.convert("RGB")
                    img.save(photo_path, format="JPEG", quality=80, optimize=True, progressive=True)
                    changed = True

            # 再度開き直さずそのままサイズ確認
            current_size = img.size
            if current_size[0] > MAX_IMAGE_SIZE[0] or current_size[1] > MAX_IMAGE_SIZE[1]:
                img.thumbnail(MAX_IMAGE_SIZE)
                if real_fmt == ".png":
                    img.save(photo_path, format="PNG", optimize=True)
                else:
                    img = img.convert("RGB")
                    img.save(photo_path, format="JPEG", quality=80, optimize=True, progressive=True)
                changed = True
                logging.info("resized: %s %s -> %s", photo_path.name, current_size, img.size)

            # サムネイル作成
            thumb = img.copy()
            thumb.thumbnail(THUMB_SIZE)
            thumbnail_path.parent.mkdir(parents=True, exist_ok=True)

            if real_fmt == ".png":
                thumb.save(thumbnail_path, format="PNG", optimize=True)
            else:
                thumb = thumb.convert("RGB")
                thumb.save(thumbnail_path, format="JPEG", quality=80, optimize=True, progressive=True)

        if need_external_compress or changed:
            compress_photo_external(photo_path)

    except UnidentifiedImageError:
        logging.warning("cannot identify image file: %s", photo_path)
    except Exception as e:
        logging.warning("process photo failed: %s (%s)", photo_path, e)


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
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(
            f"const archive_{slug} = {json_archive};\n"
            f"export default archive_{slug};"
        )

def predownload_v2_photos(df_v2: pd.DataFrame):
    jobs = []
    for row in df_v2.itertuples(index=False):
        filename = row.filename
        local_path = V2_PHOTO_DIR / filename
        if not local_path.exists():
            url = f"{V2_PHOTO_BASE_URL}/{filename}"
            jobs.append((url, local_path, filename))

    if not jobs:
        return

    logging.info("start parallel download: %d photos", len(jobs))

    with ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as executor:
        future_map = {
            executor.submit(download_file, url, path): (filename, path)
            for url, path, filename in jobs
        }

        for future in as_completed(future_map):
            filename, path = future_map[future]
            try:
                future.result()
            except Exception as e:
                logging.error("photo download failed: %s (%s)", filename, e)


# -----------------------------
# メイン処理
# -----------------------------
def main():
    ensure_dirs()
    clear_old_archive_js()

    df_hashtags = pd.read_csv(ARCHIVE_LIST_CSV)
    logging.info("loaded archive list: %d rows", len(df_hashtags))

    js_import_lines = []
    archive_list_entries = []
    archive_meta = {}

    for row in df_hashtags.itertuples(index=False):
        logging.info("========== [%s] ==========", row.slug)

        df_v1 = None
        df_v2 = None

        # ------------ v1
        if row.v1 != -1:
            target_tsv = V1_TSV_DIR / f"{row.v1}.tsv"
            logging.info("[v1] load tsv: %s", target_tsv)
            df_v1 = load_tsv(target_tsv)

            if df_v1 is not None:
                total = len(df_v1)
                for i, df_row in enumerate(df_v1.itertuples(index=False), 1):
                    filename = df_row.filename
                    src_path = V1_PHOTO_DIR / filename

                    if not src_path.exists():
                        logging.warning("[v1] photo not found: %s", src_path)
                        continue

                    archived_path = copy_if_newer(src_path, ARCHIVE_PHOTO_DIR)

                    if is_target_period(filename):
                        thumb_path = ARCHIVE_THUMB_DIR / filename
                        process_photo(archived_path, thumb_path)

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

            if df_v2 is not None:
                predownload_v2_photos(df_v2)

                total = len(df_v2)
                for i, df_row in enumerate(df_v2.itertuples(index=False), 1):
                    filename = df_row.filename
                    src_path = V2_PHOTO_DIR / filename

                    if not src_path.exists():
                        logging.warning("[v2] photo not found after download: %s", src_path)
                        continue

                    archived_path = copy_if_newer(src_path, ARCHIVE_PHOTO_DIR)

                    if is_target_period(filename):
                        thumb_path = ARCHIVE_THUMB_DIR / filename
                        process_photo(archived_path, thumb_path)

                    if i % 100 == 0 or i == total:
                        logging.info("[v2] %s progress: %d/%d", target_tsv.name, i, total)

        # ------------ concat v1 and v2
        df_archive = concat_existing_dfs(df_v1, df_v2)

        if df_archive is not None and not df_archive.empty:
            df_archive = transform_archive_dataframe(df_archive, row.name)
            json_archive = df_archive.to_json(orient="records", force_ascii=False)

            write_archive_js(row.slug, json_archive)

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

    # 統合JS出力
    with open(DOCS_ARCHIVES_JS, "w", encoding="utf-8") as f:
        f.write(
            "\n".join(js_import_lines) + "\n"
            + "export const HASHTAG_LIST = "
            + json.dumps(archive_meta, ensure_ascii=False)
            + ";\n"
            + "export default HASHTAG_LIST;\n"
            + "export const ARCHIVES = {"
            + ",".join(archive_list_entries)
            + "};"
        )

    logging.info("all done.")


if __name__ == "__main__":
    main()