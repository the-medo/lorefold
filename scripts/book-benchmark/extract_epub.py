"""Read EPUB spine documents without extracting files or fetching external resources.

This is a deliberately limited benchmark reader, not the application's importer.
Only whole XHTML spine documents are selectable; fragment-split chapters fail closed.
"""

import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET

MAX_FILE = 25 * 1024 * 1024
MAX_ENTRY = 8 * 1024 * 1024
MAX_EXPANDED = 100 * 1024 * 1024
BLOCKS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "div", "section"}
IGNORE = {"script", "style", "nav", "svg", "audio", "video", "iframe", "object"}


def local(tag):
    return tag.rsplit("}", 1)[-1]


def normalize(text):
    return " ".join(text.split())


def target(base, href):
    url = urlsplit(href)
    if url.scheme or url.netloc or url.query:
        raise ValueError("External EPUB references are unsupported")
    path = posixpath.normpath(posixpath.join(posixpath.dirname(base), unquote(url.path)))
    if path.startswith(("/", "../")) or "\\" in path:
        raise ValueError("Unsafe EPUB reference")
    return path, unquote(url.fragment)


def paragraphs(root):
    result, buffer = [], []

    def flush():
        text = normalize("".join(buffer))
        buffer.clear()
        if text:
            result.append(text)

    def walk(node):
        tag = local(node.tag)
        if tag in IGNORE:
            return
        if tag in BLOCKS:
            flush()
        if tag == "br":
            buffer.append(" ")
        if node.text:
            buffer.append(node.text)
        for child in node:
            walk(child)
            if child.tail:
                buffer.append(child.tail)
        if tag in BLOCKS:
            flush()

    walk(root)
    flush()
    return result


def extract(path):
    if Path(path).stat().st_size > MAX_FILE:
        raise ValueError("EPUB exceeds 25 MB")
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > 5000 or len(names) != len(set(names)):
            raise ValueError("Too many or duplicate ZIP entries")
        if sum(e.file_size for e in entries) > MAX_EXPANDED:
            raise ValueError("EPUB expands beyond 100 MB")
        for entry in entries:
            if entry.flag_bits & 1 or entry.file_size > MAX_ENTRY:
                raise ValueError("Encrypted or oversized ZIP entry")
            if entry.filename.startswith("/") or ".." in entry.filename.split("/") or "\\" in entry.filename:
                raise ValueError("Unsafe ZIP entry")

        def xml(name):
            # Bound reads independently of ZIP's declared size. ElementTree never
            # fetches external DTDs; reject entity declarations (including UTF-16).
            with archive.open(name) as stream:
                data = stream.read(MAX_ENTRY + 1)
            if len(data) > MAX_ENTRY or b"<!ENTITY" in data.replace(b"\x00", b"").upper():
                raise ValueError("Oversized XML or entity declarations")
            return ET.fromstring(data)

        if archive.read("mimetype") != b"application/epub+zip":
            raise ValueError("Not an EPUB container")
        if "META-INF/encryption.xml" in names:
            # Font obfuscation is harmless; encrypted XHTML cannot be analyzed.
            for node in xml("META-INF/encryption.xml").iter():
                if local(node.tag) == "CipherReference" and not node.get("URI", "").lower().endswith((".otf", ".ttf", ".woff", ".woff2")):
                    raise ValueError("Encrypted content is unsupported")
        roots = [n for n in xml("META-INF/container.xml").iter() if local(n.tag) == "rootfile"]
        if len(roots) != 1:
            raise ValueError("Expected one EPUB package")
        package_path, _ = target("", roots[0].get("full-path", ""))
        package = xml(package_path)
        manifest = {}
        for node in package.iter():
            if local(node.tag) == "item":
                ident = node.get("id")
                if not ident or ident in manifest:
                    raise ValueError("Duplicate or missing manifest ID")
                manifest[ident] = node
        spine = next((n for n in package if local(n.tag) == "spine"), None)
        if spine is None:
            raise ValueError("Missing EPUB spine")
        labels = {}
        fragment_files = set()

        def label(base, href, text):
            filename, fragment = target(base, href)
            if fragment:
                fragment_files.add(filename)
            labels.setdefault(filename, normalize(text))

        # EPUB 3 navigation, falling back to EPUB 2 NCX.
        nav = next((n for n in manifest.values() if "nav" in n.get("properties", "").split()), None)
        if nav is not None:
            nav_path, _ = target(package_path, nav.get("href", ""))
            for node in xml(nav_path).iter():
                if local(node.tag) == "nav" and "toc" in node.get("{http://www.idpf.org/2007/ops}type", "").split():
                    for link in node.iter():
                        if local(link.tag) == "a" and link.get("href"):
                            label(nav_path, link.get("href"), "".join(link.itertext()))
        elif spine.get("toc") in manifest:
            ncx_path, _ = target(package_path, manifest[spine.get("toc")].get("href", ""))
            for point in xml(ncx_path).iter():
                if local(point.tag) == "navPoint":
                    content = next((n for n in point if local(n.tag) == "content"), None)
                    title = next((n for n in point if local(n.tag) == "navLabel"), None)
                    if content is not None and title is not None:
                        label(ncx_path, content.get("src", ""), "".join(title.itertext()))

        sections, seen = [], set()
        for reference in spine:
            if reference.get("linear", "yes") == "no":
                continue
            item = manifest.get(reference.get("idref"))
            if item is None:
                raise ValueError("Spine references a missing manifest item")
            if item.get("media-type") != "application/xhtml+xml":
                continue
            filename, fragment = target(package_path, item.get("href", ""))
            if filename in seen or fragment:
                raise ValueError("Duplicate or fragmented spine document")
            seen.add(filename)
            document = xml(filename)
            body = next((n for n in document.iter() if local(n.tag) == "body"), None)
            if body is None:
                raise ValueError("XHTML document has no body")
            texts = paragraphs(body)
            if not texts:
                continue
            index = len(sections) + 1
            title = labels.get(filename) or f"Section {index} (no navigation label)"
            sections.append({"index": index, "title": title, "navigationTitle": labels.get(filename), "source": filename,
                             "fragmented": filename in fragment_files,
                             "paragraphs": [{"id": f"s{index}p{i + 1}", "text": t} for i, t in enumerate(texts)]})
        return {"sections": sections}


if __name__ == "__main__":
    try:
        print(json.dumps(extract(sys.argv[1]), ensure_ascii=False))
    except (ValueError, OSError, KeyError, ET.ParseError, zipfile.BadZipFile, RuntimeError, IndexError):
        # Do not echo private source text, filenames embedded in XML, or parser diagnostics.
        print("EPUB read failed: invalid, encrypted, oversized, or unsupported container/XML.", file=sys.stderr)
        sys.exit(1)
