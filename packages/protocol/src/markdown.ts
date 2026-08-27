export interface MarkdownHeading {
  level: number;
  title: string;
}

export interface MarkdownLine {
  index: number;
  number: number;
  text: string;
  inFence: boolean;
  heading?: MarkdownHeading;
}

interface Fence {
  marker: "`" | "~";
  length: number;
}

export function parseMarkdownHeading(line: string): MarkdownHeading | undefined {
  const match = /^ {0,3}(#{1,6})\s+(\S.*)\s*$/.exec(line);
  return match ? { level: match[1]!.length, title: match[2]! } : undefined;
}

export function scanMarkdown(markdown: string): MarkdownLine[] {
  const lines = markdown.split(/\r?\n/);
  let fence: Fence | undefined;
  return lines.map((text, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    const wasInFence = fence !== undefined;
    if (!fence && marker) {
      fence = { marker: marker[1]![0] as Fence["marker"], length: marker[1]!.length };
    } else if (fence && marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && marker[2]!.trim() === "") {
      fence = undefined;
    }
    const inFence = wasInFence || marker !== null;
    return {
      index,
      number: index + 1,
      text,
      inFence,
      ...(!inFence && parseMarkdownHeading(text) ? { heading: parseMarkdownHeading(text)! } : {}),
    };
  });
}
