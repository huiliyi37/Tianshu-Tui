// Two-dimensional layout for *display* LaTeX math: stacks `\frac` numerator over
// denominator with a horizontal bar, aligning surrounding text to the bar's row.
//
//       −b ± √(b² − 4ac)
//   x = ────────────────
//              2a
//
// Only display blocks (`$$…$$`, `\[…\]`) use this; inline `$…$` stays single-line
// (`½`, `(a+b)/c`). Everything that is not a fraction — symbols, scripts, roots,
// matrices, environments — is delegated to `latexToUnicode`, so this engine only
// adds the vertical stacking the flat string form can't express.

import { latexToUnicode } from "./latex-to-unicode.js";
import { displayWidth } from "../width.js";

/**
 * A rectangular block of rendered text. Every entry in `lines` is padded to
 * exactly `width` visible columns; `baseline` is the row that aligns with the
 * surrounding text when boxes are placed side by side (e.g. the fraction bar).
 */
interface Box {
	lines: string[];
	baseline: number;
	width: number;
}

const BAR = "─";
const FRAC_COMMANDS: Record<string, true> = { frac: true, dfrac: true, tfrac: true, cfrac: true };

// Display "wrapper" environments whose body is an expression (possibly with `\\`
// row breaks and `&` alignment). Their bodies are parsed so fractions inside
// stack; grid/structure environments (matrix/array/cases) stay opaque and are
// rendered flat by `latexToUnicode`.
const DISPLAY_ROW_ENVIRONMENTS: Record<string, true> = {
	equation: true,
	eqnarray: true,
	align: true,
	aligned: true,
	alignat: true,
	alignedat: true,
	flalign: true,
	split: true,
	gather: true,
	gathered: true,
	gatheredat: true,
	multline: true,
	displaymath: true,
	math: true,
};

function spaces(n: number): string {
	return n > 0 ? " ".repeat(n) : "";
}

/** Pad `line` on the right to `width` visible columns. */
function padRight(line: string, width: number): string {
	return line + spaces(width - displayWidth(line));
}

/** Pad `line` symmetrically (left-biased) to `width` visible columns. */
function center(line: string, width: number): string {
	const extra = width - displayWidth(line);
	if (extra <= 0) return line;
	const left = extra >> 1;
	return spaces(left) + line + spaces(extra - left);
}

/** A single rendered string (possibly multi-line) as a baseline-centered box. */
function textBox(text: string): Box {
	const raw = text.split("\n");
	let width = 0;
	for (const line of raw) width = Math.max(width, displayWidth(line));
	return { lines: raw.map(line => padRight(line, width)), baseline: (raw.length - 1) >> 1, width };
}

/** Place boxes side by side, aligning their baselines. */
function hconcat(boxes: Box[]): Box {
	if (boxes.length === 1) return boxes[0]!;
	let above = 0;
	let below = 0;
	for (const b of boxes) {
		above = Math.max(above, b.baseline);
		below = Math.max(below, b.lines.length - 1 - b.baseline);
	}
	const height = above + below + 1;
	const lines: string[] = [];
	let width = 0;
	for (const b of boxes) width += b.width;
	for (let row = 0; row < height; row++) {
		let line = "";
		for (const b of boxes) {
			const local = row - (above - b.baseline);
			line += local >= 0 && local < b.lines.length ? b.lines[local] : spaces(b.width);
		}
		lines.push(line);
	}
	return { lines, baseline: above, width };
}

/** Stack `num` over `den`, separated by a bar; the bar becomes the baseline. */
function fracBox(num: Box, den: Box): Box {
	const width = Math.max(num.width, den.width) + 2;
	const lines = [
		...num.lines.map(line => center(line, width)),
		BAR.repeat(width),
		...den.lines.map(line => center(line, width)),
	];
	return { lines, baseline: num.lines.length, width };
}

/** Stack boxes vertically (left-aligned), e.g. the rows of an aligned block. */
function vconcat(boxes: Box[]): Box {
	if (boxes.length === 1) return boxes[0]!;
	let width = 0;
	for (const b of boxes) width = Math.max(width, b.width);
	const lines: string[] = [];
	for (const b of boxes) for (const line of b.lines) lines.push(padRight(line, width));
	return { lines, baseline: (lines.length - 1) >> 1, width };
}

interface Span {
	text: string;
	end: number;
}

/** Read a balanced `{…}` beginning at `i` (which must point at `{`). */
function readBraceGroup(src: string, i: number): Span {
	let depth = 0;
	let out = "";
	let j = i;
	for (; j < src.length; j++) {
		const c = src[j];
		if (c === "\\") {
			out += c + (src[j + 1] ?? "");
			j++;
			continue;
		}
		if (c === "{") {
			depth++;
			if (depth > 1) out += c;
			continue;
		}
		if (c === "}") {
			depth--;
			if (depth === 0) {
				j++;
				break;
			}
			out += c;
			continue;
		}
		out += c;
	}
	return { text: out, end: j };
}

/**
 * Read one fraction argument: a `{…}` group, a single char, or a `\command`
 * together with its attached `[…]`/`{…}` arguments (or whole `\begin…\end`
 * block), so e.g. `\frac\sqrt{a}{b}` reads `\sqrt{a}` as the numerator.
 */
function readArg(src: string, i: number): Span {
	while (src[i] === " ") i++;
	if (i >= src.length) return { text: "", end: i };
	if (src[i] === "{") return readBraceGroup(src, i);
	if (src[i] !== "\\") return { text: src[i]!, end: i + 1 };
	let j = i + 1;
	let name = "";
	while (/[A-Za-z]/.test(src[j] ?? "")) {
		name += src[j];
		j++;
	}
	if (name === "begin") {
		const env = consumeEnvironment(src, i);
		if (env) return env;
	}
	if (!name) return { text: src.slice(i, i + 2), end: i + 2 }; // non-letter command (\,, \{, …)
	let end = j;
	while (src[end] === "[" || src[end] === "{") {
		if (src[end] === "{") end = readBraceGroup(src, end).end;
		else {
			const close = src.indexOf("]", end);
			end = close === -1 ? src.length : close + 1;
		}
	}
	return { text: src.slice(i, end), end };
}

interface EnvParts {
	env: string;
	bodyStart: number;
	bodyEnd: number;
	end: number;
}

/** Locate a `\begin{env}…\end{env}` block (balanced) starting at the backslash. */
function readEnvironment(src: string, start: number): EnvParts | null {
	let i = start + 6; // past "\begin"
	while (src[i] === " ") i++;
	if (src[i] !== "{") return null;
	const nameGroup = readBraceGroup(src, i);
	let k = nameGroup.end;
	let depth = 1;
	let bodyEnd = src.length;
	while (k < src.length && depth > 0) {
		if (src.startsWith("\\begin", k)) {
			depth++;
			k += 6;
			continue;
		}
		if (src.startsWith("\\end", k)) {
			depth--;
			if (depth === 0) bodyEnd = k;
			k += 4;
			while (src[k] === " ") k++;
			if (src[k] === "{") k = readBraceGroup(src, k).end;
			if (depth === 0) break;
			continue;
		}
		k++;
	}
	return { env: nameGroup.text.trim(), bodyStart: nameGroup.end, bodyEnd, end: k };
}

/** The full `\begin{env}…\end{env}` substring as an inline run. */
function consumeEnvironment(src: string, start: number): Span | null {
	const env = readEnvironment(src, start);
	return env ? { text: src.slice(start, env.end), end: env.end } : null;
}

/** Split an environment body on top-level `\\` row breaks (depth-aware). */
function splitRows(body: string): string[] {
	const rows: string[] = [];
	let braceDepth = 0;
	let envDepth = 0;
	let last = 0;
	let i = 0;
	while (i < body.length) {
		if (body.startsWith("\\begin", i)) {
			envDepth++;
			i += 6;
			continue;
		}
		if (body.startsWith("\\end", i)) {
			envDepth--;
			i += 4;
			continue;
		}
		const c = body[i];
		if (c === "\\") {
			if (body[i + 1] === "\\" && braceDepth === 0 && envDepth === 0) {
				rows.push(body.slice(last, i));
				i += 2;
				while (body[i] === " ") i++;
				if (body[i] === "[") {
					const close = body.indexOf("]", i);
					i = close === -1 ? body.length : close + 1;
				}
				last = i;
				continue;
			}
			i += 2; // skip escaped char / second backslash so `\{`/`\\` never skew depth
			continue;
		}
		if (c === "{") braceDepth++;
		else if (c === "}") braceDepth--;
		i++;
	}
	rows.push(body.slice(last));
	return rows;
}

/**
 * Render a `\begin{env}…\end{env}` block. Expression "wrapper" environments
 * (`equation`, `align`, `gather`, …) have their rows parsed so fractions stack;
 * grid/structure environments (matrix/array/cases) render flat via
 * `latexToUnicode`.
 */
function parseEnvironment(src: string, start: number): { box: Box; end: number } | null {
	const env = readEnvironment(src, start);
	if (env === null) return null;
	const base = env.env.endsWith("*") ? env.env.slice(0, -1) : env.env;
	if (!DISPLAY_ROW_ENVIRONMENTS[base]) {
		return { box: textBox(latexToUnicode(src.slice(start, env.end))), end: env.end };
	}
	let bodyStart = env.bodyStart;
	if (base === "alignat" || base === "alignedat" || base === "gatheredat") {
		// These carry a required column-count argument `{n}` before the body.
		let p = bodyStart;
		while (src[p] === " " || src[p] === "\n") p++;
		if (src[p] === "{") bodyStart = readBraceGroup(src, p).end;
	}
	const rows = splitRows(src.slice(bodyStart, env.bodyEnd))
		.map(row => row.trim())
		.filter(row => row !== "")
		.map(row => parseExpr(row));
	return { box: rows.length > 0 ? vconcat(rows) : textBox(""), end: env.end };
}

/** Append a script (`^`/`_`) and its argument to the inline run verbatim. */
function readScript(src: string, i: number): Span {
	let out = src[i]!;
	i++;
	while (src[i] === " ") {
		out += src[i]!;
		i++;
	}
	if (src[i] === "{") {
		const group = readBraceGroup(src, i);
		return { text: `${out}{${group.text}}`, end: group.end };
	}
	if (src[i] === "\\") {
		let j = i + 1;
		if (/[A-Za-z]/.test(src[j] ?? "")) while (/[A-Za-z]/.test(src[j] ?? "")) j++;
		else j++;
		return { text: out + src.slice(i, j), end: j };
	}
	if (i < src.length) return { text: out + src[i]!, end: i + 1 };
	return { text: out, end: i };
}

/**
 * Parse a math fragment into a layout box, stacking top-level fractions (and
 * fractions nested inside other fractions' arguments). Non-fraction runs —
 * including scripts, roots, environments, and command arguments — are gathered
 * into inline strings and rendered through `latexToUnicode`.
 */
function parseExpr(src: string): Box {
	const boxes: Box[] = [];
	let inline = "";
	const flush = (): void => {
		if (inline) {
			boxes.push(textBox(latexToUnicode(inline)));
			inline = "";
		}
	};
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			let j = i + 1;
			let name = "";
			while (j < src.length && /[A-Za-z]/.test(src[j]!)) {
			name += src[j]!;
				j++;
			}
			if (name && FRAC_COMMANDS[name]) {
				flush();
				const num = readArg(src, j);
				const den = readArg(src, num.end);
				boxes.push(fracBox(parseExpr(num.text), parseExpr(den.text)));
				i = den.end;
				continue;
			}
			if (name === "begin") {
				const env = parseEnvironment(src, i);
				if (env) {
					flush();
					boxes.push(env.box);
					i = env.end;
					continue;
				}
			}
			if (!name) {
				// Non-letter command (`\\`, `\,`, `\{`, …): keep the 2-char token inline.
				inline += `\\${src[j] ?? ""}`;
				i = j + 1;
				continue;
			}
			// Other command: keep it and its bracket/brace arguments inline so a
			// `{…}` argument is never mistaken for a top-level stacking group.
			inline += `\\${name}`;
			i = j;
			while (src[i] === "[" || src[i] === "{") {
				if (src[i] === "{") {
					const group = readBraceGroup(src, i);
					inline += `{${group.text}}`;
					i = group.end;
				} else {
					const close = src.indexOf("]", i);
					const end = close === -1 ? src.length : close + 1;
					inline += src.slice(i, end);
					i = end;
				}
			}
			continue;
		}
		if (c === "^" || c === "_") {
			const script = readScript(src, i);
			inline += script.text;
			i = script.end;
			continue;
		}
		if (c === "{") {
			const group = readBraceGroup(src, i);
			flush();
			boxes.push(parseExpr(group.text));
			i = group.end;
			continue;
		}
		inline += c;
		i++;
	}
	flush();
	if (boxes.length === 0) return textBox("");
	return hconcat(boxes);
}

/** Split on top-level `\n` row separators (outside braces and environments). */
function splitLines(src: string): string[] {
	const lines: string[] = [];
	let braceDepth = 0;
	let envDepth = 0;
	let last = 0;
	let i = 0;
	while (i < src.length) {
		if (src.startsWith("\\begin", i)) {
			envDepth++;
			i += 6;
			continue;
		}
		if (src.startsWith("\\end", i)) {
			envDepth--;
			i += 4;
			continue;
		}
		const c = src[i];
		if (c === "\\") {
			i += 2; // escaped char / second backslash — never a logical-line break
			continue;
		}
		if (c === "{") braceDepth++;
		else if (c === "}") braceDepth--;
		else if (c === "\n" && braceDepth === 0 && envDepth === 0) {
			lines.push(src.slice(last, i));
			last = i + 1;
		}
		i++;
	}
	lines.push(src.slice(last));
	return lines;
}

/**
 * Render a display LaTeX math fragment to lines, stacking `\frac` vertically.
 * Top-level source newlines become vertical rows (so a `lhs =` line stays above
 * its block); each row stacks fractions via `parseExpr`. Inline math should use
 * `latexToUnicode` instead — fractions there stay single-line.
 */
export function latexToBlock(src: string): string[] {
	if (typeof src !== "string" || src.trim() === "") return [];
	const rows = splitLines(src.trim())
		.map(line => line.trim())
		.filter(line => line !== "")
		.map(line => parseExpr(line));
	if (rows.length === 0) return [];
	let lines = vconcat(rows).lines;
	while (lines.length > 1 && lines[lines.length - 1]!.trim() === "") lines = lines.slice(0, -1);
	while (lines.length > 1 && lines[0]!.trim() === "") lines = lines.slice(1);
	return lines;
}
