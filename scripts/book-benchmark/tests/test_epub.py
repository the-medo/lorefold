import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("extract_epub", Path(__file__).parents[1] / "extract_epub.py")
epub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(epub)


def fixture(path, *, epub3=False, fragment=False, body=None, extra=None):
    package = '''<package xmlns="http://www.idpf.org/2007/opf"><manifest>
      <item id="c1" href="chapter%201.xhtml" media-type="application/xhtml+xml"/>
      <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
      <item id="bonus" href="bonus.xhtml" media-type="application/xhtml+xml"/>
      <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
      <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
      </manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/><itemref idref="bonus"/></spine></package>'''
    if not epub3:
        package = package.replace(' properties="nav"', '')
    suffix = "#start" if fragment else ""
    files = {
        "mimetype": "application/epub+zip",
        "META-INF/container.xml": '<container><rootfiles><rootfile full-path="book/package.opf"/></rootfiles></container>',
        "book/package.opf": package,
        "book/toc.ncx": f'''<ncx><navMap><navPoint><navLabel><text>Chapter 1</text></navLabel><content src="chapter%201.xhtml{suffix}"/></navPoint>
          <navPoint><navLabel><text>Chapter 2</text></navLabel><content src="chapter2.xhtml"/></navPoint>
          <navPoint><navLabel><text>Bonus story</text></navLabel><content src="bonus.xhtml"/></navPoint></navMap></ncx>''',
        "book/nav.xhtml": f'''<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>
          <li><a href="chapter%201.xhtml{suffix}">Chapter 1</a></li><li><a href="chapter2.xhtml">Chapter 2</a></li>
          <li><a href="bonus.xhtml">Bonus story</a></li></ol></nav></body></html>''',
        "book/chapter 1.xhtml": body or '<html><body><h1>Chapter 1</h1><p>Ada holds a <em>brass</em> key.</p><script>DO NOT INCLUDE</script><p>Rowan waits.<br/>Morning comes.</p></body></html>',
        "book/chapter2.xhtml": '<html><body><p>Ada opens the observatory.</p></body></html>',
        "book/bonus.xhtml": '<html><body><p>A different story.</p></body></html>',
    }
    files.update(extra or {})
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, value in files.items():
            archive.writestr(name, value)


class EpubTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "synthetic.epub"

    def tearDown(self):
        self.temp.cleanup()

    def test_epub2_spine_navigation_and_inline_text(self):
        fixture(self.path)
        sections = epub.extract(self.path)["sections"]
        self.assertEqual([s["title"] for s in sections], ["Chapter 1", "Chapter 2", "Bonus story"])
        self.assertEqual(sections[0]["paragraphs"][1], {"id": "s1p2", "text": "Ada holds a brass key."})
        self.assertEqual(sections[0]["paragraphs"][2]["text"], "Rowan waits. Morning comes.")
        self.assertNotIn("DO NOT INCLUDE", str(sections))
        self.assertFalse(sections[0]["fragmented"])
        self.assertEqual(list(Path(self.temp.name).iterdir()), [self.path])

    def test_epub3_navigation_and_fragment_warning(self):
        fixture(self.path, epub3=True, fragment=True)
        sections = epub.extract(self.path)["sections"]
        self.assertEqual(sections[0]["title"], "Chapter 1")
        self.assertTrue(sections[0]["fragmented"])

    def test_xml_entities_and_traversal_are_rejected(self):
        fixture(self.path, body='<!DOCTYPE html [<!ENTITY leak SYSTEM "file:///etc/passwd">]><html><body><p>&leak;</p></body></html>')
        with self.assertRaises(ValueError):
            epub.extract(self.path)
        fixture(self.path, extra={"../outside": "no"})
        with self.assertRaises(ValueError):
            epub.extract(self.path)
        for href in ["../../outside", "https://example.com/book.xhtml", "%2e%2e/%2e%2e/outside", "//example.com/book.xhtml"]:
            with self.assertRaises(ValueError):
                epub.target("book/package.opf", href)

    def test_encrypted_content_is_rejected_but_fonts_are_allowed(self):
        fixture(self.path, extra={"META-INF/encryption.xml": '<encryption><CipherReference URI="book/chapter2.xhtml"/></encryption>'})
        with self.assertRaises(ValueError):
            epub.extract(self.path)
        fixture(self.path, extra={"META-INF/encryption.xml": '<encryption><CipherReference URI="book/font.otf"/></encryption>'})
        self.assertEqual(len(epub.extract(self.path)["sections"]), 3)

    def test_oversized_expansion_and_duplicate_entries_are_rejected(self):
        fixture(self.path, extra={"large.txt": "x" * (epub.MAX_ENTRY + 1)})
        with self.assertRaises(ValueError):
            epub.extract(self.path)
        fixture(self.path)
        with zipfile.ZipFile(self.path, "a") as archive:
            with self.assertWarns(UserWarning):
                archive.writestr("mimetype", "application/epub+zip")
        with self.assertRaises(ValueError):
            epub.extract(self.path)


if __name__ == "__main__":
    unittest.main()
