export type ZoneType = "frontmatter" | "prose" | "code-fence" | "inline-code" | "blockquote" | "html-comment";

export interface Zone {
  type: ZoneType;
  content: string;
  startLine: number;
  endLine: number;
}

interface BodySlice {
  bodyLines: string[];
  bodyStartLine: number;
}

interface OpenCodeFence {
  delimiter: string;
  zone: Zone;
}

function splitLines(raw: string): string[] {
  return raw.split(/\r?\n/);
}

function stripTopFrontmatter(raw: string): BodySlice {
  const lines = splitLines(raw);
  if (lines[0] !== "---") {
    return {
      bodyLines: lines,
      bodyStartLine: 1
    };
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      return {
        bodyLines: lines.slice(index + 1),
        bodyStartLine: index + 2
      };
    }
  }

  return {
    bodyLines: lines,
    bodyStartLine: 1
  };
}

function matchCodeFenceOpener(line: string): string | null {
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  return match?.[1] ?? null;
}

function isExactCodeFenceCloser(line: string, delimiter: string): boolean {
  return line.trim() === delimiter;
}

function appendZone(zones: Zone[], type: ZoneType, content: string, startLine: number, endLine: number): void {
  if (content === "") {
    return;
  }

  const previous = zones[zones.length - 1];
  if (previous && previous.type === type && startLine <= previous.endLine + 1) {
    const separator = startLine > previous.endLine ? "\n" : "";
    previous.content += `${separator}${content}`;
    previous.endLine = endLine;
    return;
  }

  zones.push({
    type,
    content,
    startLine,
    endLine
  });
}

function appendToOpenZone(zone: Zone, content: string, lineNumber: number): void {
  if (content === "") {
    if (lineNumber > zone.endLine) {
      zone.content += "\n";
      zone.endLine = lineNumber;
    }
    return;
  }

  const separator = lineNumber > zone.endLine ? "\n" : "";
  zone.content += `${separator}${content}`;
  zone.endLine = lineNumber;
}

function addInlineAwareText(zones: Zone[], text: string, lineNumber: number, baseType: "prose" | "blockquote"): void {
  if (text === "") {
    return;
  }

  let cursor = 0;
  while (cursor < text.length) {
    const inlineStart = text.indexOf("`", cursor);
    if (inlineStart === -1) {
      appendZone(zones, baseType, text.slice(cursor), lineNumber, lineNumber);
      return;
    }

    if (inlineStart > cursor) {
      appendZone(zones, baseType, text.slice(cursor, inlineStart), lineNumber, lineNumber);
    }

    const inlineEnd = text.indexOf("`", inlineStart + 1);
    if (inlineEnd === -1) {
      appendZone(zones, baseType, text.slice(inlineStart), lineNumber, lineNumber);
      return;
    }

    appendZone(zones, "inline-code", text.slice(inlineStart, inlineEnd + 1), lineNumber, lineNumber);
    cursor = inlineEnd + 1;
  }
}

export function parseZones(raw: string): Zone[] {
  const { bodyLines, bodyStartLine } = stripTopFrontmatter(raw);
  const zones: Zone[] = [];
  let openCodeFence: OpenCodeFence | null = null;
  let openComment: Zone | null = null;

  for (const [index, line] of bodyLines.entries()) {
    const lineNumber = bodyStartLine + index;

    if (openCodeFence) {
      appendToOpenZone(openCodeFence.zone, line, lineNumber);
      if (isExactCodeFenceCloser(line, openCodeFence.delimiter)) {
        zones.push(openCodeFence.zone);
        openCodeFence = null;
      }
      continue;
    }

    if (!openComment) {
      const fenceDelimiter = matchCodeFenceOpener(line);
      if (fenceDelimiter) {
        openCodeFence = {
          delimiter: fenceDelimiter,
          zone: {
            type: "code-fence",
            content: line,
            startLine: lineNumber,
            endLine: lineNumber
          }
        };
        continue;
      }
    }

    const baseType: "prose" | "blockquote" = /^\s*>/.test(line) ? "blockquote" : "prose";
    let cursor = 0;

    while (cursor < line.length || openComment) {
      if (openComment) {
        const closeIndex = line.indexOf("-->", cursor);
        if (closeIndex === -1) {
          appendToOpenZone(openComment, line.slice(cursor), lineNumber);
          cursor = line.length;
          break;
        }

        appendToOpenZone(openComment, line.slice(cursor, closeIndex + 3), lineNumber);
        zones.push(openComment);
        openComment = null;
        cursor = closeIndex + 3;
        continue;
      }

      if (cursor >= line.length) {
        break;
      }

      const commentStart = line.indexOf("<!--", cursor);
      const textEnd = commentStart === -1 ? line.length : commentStart;

      if (textEnd > cursor) {
        addInlineAwareText(zones, line.slice(cursor, textEnd), lineNumber, baseType);
      }

      if (commentStart === -1) {
        break;
      }

      const commentEnd = line.indexOf("-->", commentStart + 4);
      if (commentEnd === -1) {
        openComment = {
          type: "html-comment",
          content: line.slice(commentStart),
          startLine: lineNumber,
          endLine: lineNumber
        };
        break;
      }

      appendZone(zones, "html-comment", line.slice(commentStart, commentEnd + 3), lineNumber, lineNumber);
      cursor = commentEnd + 3;
    }
  }

  if (openComment) {
    zones.push(openComment);
  }

  if (openCodeFence) {
    zones.push(openCodeFence.zone);
  }

  return zones;
}
