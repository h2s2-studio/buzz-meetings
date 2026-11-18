// Matches a transcript entry to one option of a question an agent asked in the call.
// It only offers the match to the agent (via: "speech"); nothing is executed here,
// and the speaker label is a media label, not verified identity.

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
const affirm = ["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "go ahead", "do it", "please do", "sounds good", "let's do it", "lets do it"];
const decline = ["no", "nope", "not yet", "not now", "don't", "dont", "hold off", "wait", "skip it"];
const starts = (text: string, phrase: string) => text === phrase || text.startsWith(`${phrase} `);

/**
 * The option a short reply plainly chooses, or undefined. Plain means: the reply is (or
 * starts with) the option's words, or a clear yes/no when exactly one option reads as
 * yes or no. Long remarks never match, so discussion is not mistaken for an answer.
 */
export function spokenOption(text: string, options: readonly string[]) {
  const said = normalize(text);
  if (!said || said.split(" ").length > 8) return undefined;
  const labels = options.map(normalize);
  const exact = labels.filter(label => label && (starts(said, label) || said.endsWith(` ${label}`)));
  if (exact.length === 1) return options[labels.indexOf(exact[0])];
  if (exact.length > 1) return undefined;
  // A generic yes/no is short and names nothing else: "yeah go ahead" counts, "ok so where were we" does not.
  const words = said.split(" ");
  if (words.length > 4 || labels.some(label => label.split(" ").some(word => word.length > 3 && !affirm.includes(word) && !decline.includes(word) && words.includes(word)))) return undefined;
  const filler = new Set([...affirm, ...decline].flatMap(phrase => phrase.split(" ")).concat(["please", "then", "lets", "let's", "it", "that", "thanks", "good", "great"]));
  if (!words.every(word => filler.has(word))) return undefined;
  const yes = labels.filter(label => affirm.some(word => starts(label, word))), no = labels.filter(label => decline.some(word => starts(label, word)));
  if (yes.length === 1 && affirm.some(word => starts(said, word)) && !decline.some(word => starts(said, word))) return options[labels.indexOf(yes[0])];
  if (no.length === 1 && decline.some(word => starts(said, word))) return options[labels.indexOf(no[0])];
  return undefined;
}
