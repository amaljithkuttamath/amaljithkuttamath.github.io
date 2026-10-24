import { marked } from "marked";
import createDOMPurify from "dompurify";
import { safeURL, validDate } from "./data";
export function digestView(markdown: string, document: Document) {
  const html = marked.parse(
    markdown.replace(/<!-- radar:nav -->[\s\S]*?<!-- \/radar:nav -->/g, ""),
    { async: false },
  );
  const root = document.createElement("article");
  root.className = "radar-prose";
  root.innerHTML = createDOMPurify(document.defaultView!).sanitize(html, {
    ALLOWED_TAGS: [
      "p",
      "a",
      "strong",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "ul",
      "ol",
      "li",
      "blockquote",
      "code",
      "pre",
      "br",
      "hr",
      "table",
      "thead",
      "tbody",
      "tr",
      "td",
      "th",
    ],
    ALLOWED_ATTR: ["href", "title"],
    ALLOW_DATA_ATTR: false,
  });
  const h1 = root.querySelector("h1"),
    date = h1?.textContent?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!date || !validDate(date))
    throw new Error("This report is missing a valid edition date.");
  h1!.remove();
  root.querySelectorAll("a").forEach((a) => {
    const url = safeURL(a.getAttribute("href"));
    if (url) {
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    } else a.removeAttribute("href");
  });
  for (const p of root.querySelectorAll(":scope > p")) {
    if (
      p.children.length === 1 &&
      p.firstElementChild?.tagName === "STRONG" &&
      !p.querySelector("a") &&
      p.textContent!.length < 70
    ) {
      const h = document.createElement("h2");
      h.textContent = p.textContent;
      p.replaceWith(h);
    }
  }
  const lead = root.querySelector(":scope > p");
  const sections = [...root.querySelectorAll("h2")].map((h, i) => {
    h.id = `brief-section-${i}`;
    return { id: h.id, title: h.textContent || "" };
  });
  const candidates = [
    ...root.querySelectorAll("p > strong:first-child"),
  ].filter((s) => s.querySelector("a[href]"));
  // Preserve source order while giving different published sections a place in the overview.
  const categories = new Set<string>();
  const selected = candidates
    .filter((s) => {
      let previous = s.parentElement?.previousElementSibling;
      while (previous && !/^H[23]$/.test(previous.tagName))
        previous = previous.previousElementSibling;
      const category = previous?.textContent || "";
      if (categories.has(category)) return false;
      categories.add(category);
      return true;
    })
    .slice(0, 3);
  for (const candidate of candidates)
    if (selected.length < 3 && !selected.includes(candidate))
      selected.push(candidate);
  const stories = selected.map((s) => {
    const parent = s.parentElement!.cloneNode(true) as HTMLElement;
    parent.querySelector("strong")?.remove();
    parent.innerHTML = parent.innerHTML.replace(/^\s*[—–-]\s*/, "");
    return {
      title: s.textContent || "",
      url: s.querySelector("a")!.href,
      body: parent.innerHTML,
    };
  });
  let actions = "";
  const heading = [...root.querySelectorAll("h2")].find((h) =>
    /action items/i.test(h.textContent || ""),
  );
  if (heading) {
    let node = heading.nextElementSibling;
    while (node && !/^H[12]$/.test(node.tagName)) {
      actions += node.outerHTML;
      node = node.nextElementSibling;
    }
  }
  const degraded = /Degraded run|no model synthesis/i.test(markdown);
  return {
    root,
    date,
    lead: lead?.innerHTML || "Open the full briefing to read this edition.",
    stories,
    sections,
    actions,
    degraded,
    minutes: Math.max(
      1,
      Math.ceil(root.textContent!.split(/\s+/).length / 220),
    ),
  };
}
