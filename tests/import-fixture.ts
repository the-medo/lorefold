import { execFileSync } from "node:child_process";
// Original synthetic source; ZIP is generated in memory, never uses a private book.
export function importFixture() {
  return execFileSync("python3", ["-c", `import io, sys, zipfile
out = io.BytesIO()
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
 z.writestr("mimetype", "application/epub+zip")
 z.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
 z.writestr("book.opf", '<package><manifest><item id="story" href="story.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="story"/></spine></package>')
 z.writestr("nav.xhtml", '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><a href="story.xhtml#one">Chapter 1</a><a href="story.xhtml#two">Chapter 2</a></nav></body></html>')
 z.writestr("story.xhtml", '<html><body><h1 id="one">Chapter 1</h1><p>Ada carries the brass key to Rowan at the observatory.</p><h1 id="two">Chapter 2</h1><p>Ada discovers Rowan is Leon, her missing brother.</p></body></html>')
sys.stdout.buffer.write(out.getvalue())`]);
}
