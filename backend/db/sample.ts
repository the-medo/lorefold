import { db } from "./client.js";
import * as s from "./schema.js";

// Original, deterministic fiction. No model, remote provider, or private source material.
export const sampleChapters = [
  {
    number: 1,
    title: "A light in the fog",
    text: "Mara, a courier, arrived at Bellweather Harbor with a brass compass. Its needle pointed toward the dark lighthouse instead of north. At the pier, a stranger in a grey coat offered to guide her across the water. The stranger called herself only the keeper. Together they watched a single light pulse from the abandoned tower.",
    recap:
      "Mara reaches Bellweather Harbor carrying a compass that refuses to point north. A mysterious keeper offers to guide her toward the lighthouse. Though the tower is thought to be abandoned, a light is burning inside.",
    developments: [
      "The brass compass points toward the lighthouse.",
      "Mara meets a stranger known only as the keeper.",
      "A light appears in the abandoned tower.",
    ],
  },
  {
    number: 2,
    title: "The keeper’s name",
    text: "Inside the lighthouse, the keeper told Mara her name was Iona. Iona had tended the tower for twenty years. She fitted the brass compass into a hollow in the lantern mechanism. A beam illuminated a chart carved into the wall. Iona said the chart marked a safe passage through the reef, but she did not explain who had made it.",
    recap:
      "The keeper introduces herself as Iona, the lighthouse’s longtime caretaker. Mara’s compass fits the lantern mechanism and reveals a hidden chart. It shows a route through the reef; its makers remain unknown.",
    developments: [
      "The keeper’s name is Iona.",
      "The compass is a key to the lantern mechanism.",
      "A hidden chart reveals a safe passage through the reef.",
    ],
  },
  {
    number: 3,
    title: "The tidekeepers",
    text: "Iona opened a panel behind the chart, revealing the crest of the Tidekeepers. “I belong to the Tidekeepers,” she told Mara. “We made this passage to bring stranded sailors home.” Mara agreed to carry their chart to the next harbor. At dawn, Iona lit the lighthouse while Mara set out with the brass compass and a copy of the route.",
    recap:
      "Iona reveals that she belongs to the Tidekeepers, who created the passage to rescue stranded sailors. Mara agrees to deliver their chart to the next harbor. With the lighthouse shining again, she leaves carrying the route and the compass.",
    developments: [
      "Iona reveals her allegiance to the Tidekeepers.",
      "The passage was made to rescue stranded sailors.",
      "Mara agrees to carry the chart onward.",
    ],
  },
];

export async function seedSample(userId: string) {
  const bookId = `sample-${userId}`;
  await db.transaction(async (tx) => {
    const universeId = `sample-universe-${userId}`;
    await tx.insert(s.universes).values({
      id: universeId, ownerId: userId, name: "Bellweather",
      description: "A fogbound coast, a wayward compass, and stories carried by the tide.",
    }).onConflictDoNothing();
    // The book row is the atomic seed marker. Re-runs never reset reader progress.
    const inserted = await tx
      .insert(s.books)
      .values({
        id: bookId,
        ownerId: userId,
        universeId,
        title: "The Lantern at Bellweather",
        author: "A Lorefold original",
        description:
          "A courier. A wayward compass. A light where no light should be. Follow a small mystery along a fogbound coast.",
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) return;
    await tx
      .insert(s.chapters)
      .values(sampleChapters.map((c) => ({ ...c, bookId, analyzed: true })));
    await tx.insert(s.progress).values({ bookId, userId, completedChapter: 0 });
    await tx.insert(s.entities).values(
      [
        { id: "e1", kind: "character" },
        { id: "e2", kind: "character" },
        { id: "e3", kind: "location" },
        { id: "e4", kind: "location" },
        { id: "e5", kind: "object" },
        { id: "e6", kind: "faction" },
      ].map((e) => ({
        ...e,
        bookId,
        kind: e.kind as "character" | "location" | "object" | "faction",
      })),
    );
    const passages = [
      {
        id: "p1",
        chapter: 1,
        quote:
          "Mara, a courier, arrived at Bellweather Harbor with a brass compass.",
      },
      {
        id: "p2",
        chapter: 1,
        quote:
          "Its needle pointed toward the dark lighthouse instead of north.",
      },
      {
        id: "p3",
        chapter: 1,
        quote:
          "At the pier, a stranger in a grey coat offered to guide her across the water. The stranger called herself only the keeper.",
      },
      {
        id: "p4",
        chapter: 1,
        quote:
          "Together they watched a single light pulse from the abandoned tower.",
      },
      {
        id: "p5",
        chapter: 2,
        quote:
          "Inside the lighthouse, the keeper told Mara her name was Iona. Iona had tended the tower for twenty years.",
      },
      {
        id: "p6",
        chapter: 2,
        quote:
          "She fitted the brass compass into a hollow in the lantern mechanism. A beam illuminated a chart carved into the wall.",
      },
      {
        id: "p7",
        chapter: 3,
        quote:
          "Iona opened a panel behind the chart, revealing the crest of the Tidekeepers. “I belong to the Tidekeepers,” she told Mara. “We made this passage to bring stranded sailors home.”",
      },
      {
        id: "p8",
        chapter: 3,
        quote: "Mara agreed to carry their chart to the next harbor.",
      },
    ];
    for (const p of passages) {
      if (!sampleChapters[p.chapter - 1].text.includes(p.quote))
        throw new Error("Sample evidence must be a source substring.");
    }
    await tx.insert(s.evidence).values(passages.map((p) => ({ ...p, bookId })));
    const factRows: {
      entityId: string;
      kind: "label" | "description" | "alias";
      value: string;
      revealChapter: number;
      evidenceId: string;
    }[] = [];
    const fact = (
      entityId: string,
      chapter: number,
      evidenceId: string,
      label: string | null,
      description: string,
    ) => {
      if (label)
        factRows.push({
          entityId,
          kind: "label",
          value: label,
          revealChapter: chapter,
          evidenceId,
        });
      factRows.push({
        entityId,
        kind: "description",
        value: description,
        revealChapter: chapter,
        evidenceId,
      });
    };
    fact(
      "e1",
      1,
      "p1",
      "Mara",
      "A courier who arrives at Bellweather Harbor carrying a brass compass.",
    );
    fact(
      "e2",
      1,
      "p3",
      "The keeper",
      "A stranger in a grey coat who offers to guide Mara across the water.",
    );
    fact(
      "e3",
      1,
      "p1",
      "Bellweather Harbor",
      "The harbor where Mara arrives with the compass.",
    );
    fact(
      "e4",
      1,
      "p4",
      "The lighthouse",
      "An abandoned tower where a light unexpectedly appears.",
    );
    fact(
      "e5",
      1,
      "p2",
      "Brass compass",
      "Its needle points toward the lighthouse instead of north.",
    );
    fact(
      "e2",
      2,
      "p5",
      "Iona",
      "The keeper gives her name as Iona; she has tended the tower for twenty years.",
    );
    factRows.push({
      entityId: "e2",
      kind: "alias",
      value: "The keeper",
      revealChapter: 2,
      evidenceId: "p5",
    });
    fact(
      "e5",
      2,
      "p6",
      null,
      "Fits into the lantern mechanism and reveals a hidden chart.",
    );
    fact(
      "e2",
      3,
      "p7",
      null,
      "A member of the Tidekeepers, who made a passage to rescue stranded sailors.",
    );
    fact(
      "e6",
      3,
      "p7",
      "Tidekeepers",
      "A group that made a safe passage to bring stranded sailors home.",
    );
    fact(
      "e1",
      3,
      "p8",
      null,
      "Agrees to carry the Tidekeepers’ chart to the next harbor.",
    );
    await tx
      .insert(s.facts)
      .values(
        factRows.map((f, index) => ({ ...f, bookId, id: `f${index + 1}` })),
      );
    await tx
      .insert(s.appearances)
      .values(
        [
          ...["e1", "e2", "e3", "e4", "e5"].map((entityId) => ({
            entityId,
            chapter: 1,
          })),
          ...["e1", "e2", "e4", "e5"].map((entityId) => ({
            entityId,
            chapter: 2,
          })),
          ...["e1", "e2", "e4", "e5", "e6"].map((entityId) => ({
            entityId,
            chapter: 3,
          })),
        ].map((a) => ({ ...a, bookId })),
      );
    await tx.insert(s.relationships).values(
      [
        {
          id: "r1",
          sourceId: "e1",
          targetId: "e3",
          label: "arrives at",
          revealChapter: 1,
          evidenceId: "p1",
        },
        {
          id: "r2",
          sourceId: "e1",
          targetId: "e5",
          label: "carries",
          revealChapter: 1,
          evidenceId: "p1",
        },
        {
          id: "r3",
          sourceId: "e2",
          targetId: "e1",
          label: "offers to guide",
          revealChapter: 1,
          evidenceId: "p3",
        },
        {
          id: "r4",
          sourceId: "e5",
          targetId: "e4",
          label: "points toward",
          revealChapter: 1,
          evidenceId: "p2",
        },
        {
          id: "r5",
          sourceId: "e2",
          targetId: "e4",
          label: "tends",
          revealChapter: 2,
          evidenceId: "p5",
        },
        {
          id: "r6",
          sourceId: "e2",
          targetId: "e6",
          label: "belongs to",
          revealChapter: 3,
          evidenceId: "p7",
        },
        {
          id: "r7",
          sourceId: "e1",
          targetId: "e6",
          label: "carries a chart for",
          revealChapter: 3,
          evidenceId: "p8",
        },
      ].map((r) => ({ ...r, bookId })),
    );
  });
  return bookId;
}
