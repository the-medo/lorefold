# Theme fonts

Every interface, heading, and reading picker exposes the same 28 choices. Font
roles remain independent: a pairing is a starting point, and every font can be
changed individually. Existing saved keys, including the five system stacks,
remain supported without a schema migration.

## Collection

The 23 bundled families are pinned [Fontsource](https://fontsource.org/) packages.
They are served by Lorefold, not a font CDN. CSS declares every supported subset;
the browser downloads only families, weights, styles, and subsets actually used.
Opening the picker does not download the whole collection. Every family includes
upright and italic faces. Variable fonts provide their available weight range;
IBM Plex Mono includes 400, 500, 600, and 700 in both styles.

| Group | Bundled families |
| --- | --- |
| Sans serif | DM Sans, Figtree, Inter, Noto Sans, Nunito Sans, Public Sans, Rubik, Source Sans 3, Work Sans |
| Serif | Crimson Pro, EB Garamond, Fraunces, Libre Baskerville, Literata, Lora, Merriweather, Newsreader, Noto Serif, Source Serif 4 |
| Monospace | IBM Plex Mono, JetBrains Mono, Roboto Mono, Source Code Pro |

System sans, Humanist sans, Classic serif, Book serif, and Monospace use device
fonts. Their appearance and glyph coverage depend on the operating system.
Bundled families also differ in language coverage; missing glyphs fall back to the
browser's serif, sans-serif, or monospace stack.

The original font copyright and SIL Open Font License notices are included in
`frontend/public/fonts/licenses/<package-id>.txt` and copied unchanged to the
production site. Sources and upstream attribution are also recorded in each
package's `metadata.json` and `LICENSE`.

## Curated combinations

`shared/theme-fonts.ts` is the source of truth for these combinations. Literary
pairings use serif reading faces with quieter sans-serif controls. Modern pairings
use sans-serif faces throughout, mixing expressive headings with simple reading
faces. Terminal pairings keep a sans-serif interface alongside monospaced headings
and reading text.

| Style | Pairing | Interface | Heading | Reading |
| --- | --- | --- | --- | --- |
| Literary | Fireside | Inter | Lora | Lora |
| Literary | Library | Source Sans 3 | Literata | Source Serif 4 |
| Literary | Sunday edition | Work Sans | Fraunces | Newsreader |
| Literary | Classic volume | Public Sans | Libre Baskerville | Libre Baskerville |
| Literary | Old world | DM Sans | EB Garamond | EB Garamond |
| Literary | Storybook | Nunito Sans | Merriweather | Merriweather |
| Literary | Atlas | Noto Sans | Noto Serif | Noto Serif |
| Literary | Manuscript | Figtree | Crimson Pro | Crimson Pro |
| Literary | Reading room | Rubik | Newsreader | Literata |
| Literary | Folktale | Source Sans 3 | Fraunces | Fraunces |
| Modern | Clear space | Inter | Inter | Inter |
| Modern | Field notes | Source Sans 3 | Source Sans 3 | Source Sans 3 |
| Modern | Studio | DM Sans | Rubik | DM Sans |
| Modern | Civic | Public Sans | Work Sans | Public Sans |
| Modern | Daybreak | Figtree | DM Sans | Figtree |
| Modern | Soft focus | Nunito Sans | Nunito Sans | Nunito Sans |
| Modern | Workshop | Work Sans | Figtree | Work Sans |
| Modern | Wayfinder | Noto Sans | Noto Sans | Noto Sans |
| Modern | Playful geometry | Rubik | Public Sans | Rubik |
| Terminal | Night console | Inter | JetBrains Mono | JetBrains Mono |
| Terminal | Source notes | Source Sans 3 | Source Code Pro | Source Code Pro |
| Terminal | Archive terminal | Public Sans | IBM Plex Mono | IBM Plex Mono |
| Terminal | Orbital log | Rubik | Roboto Mono | Roboto Mono |

Generation starts at a random variation and advances on each accepted click.
Within a style, `variation % pairings.length` selects the combination. Every
pairing is visited before repeating, and adjacent pairings change all three roles,
including the end of a cycle. Light/dark affects colors, not font compatibility.
Saved themes store the selected font keys independently of this list.

## Maintaining the collection

1. Install a pinned font package and verify its family name, weights, styles,
   subsets, and original license. Prefer readable faces with genuine italics.
2. Add a stable key in `shared/theme-fonts.ts`, CSS imports in
   `frontend/src/fonts.css`, and an unchanged license in
   `frontend/public/fonts/licenses/`. Never remove or repurpose a saved key.
3. Include the family in suitable curated combinations. Preserve changes between
   adjacent triples and through cycle wraparound. Update the table above.
4. Run the normal typecheck, build, unit/API tests, and theme browser tests through
   the worktree launcher. Tests check asset signatures, CSS family names, license
   copies, pairing coverage, each family loading in regular/bold/italic styles, font changes
   during generation, and saved choices surviving reload.
