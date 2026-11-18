import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const built = await build({ entryPoints: ["src/spoken-answer.ts"], bundle: true, format: "esm", platform: "node", write: false });
const { spokenOption } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("plain yes/no replies match the yes-like or no-like option", () => {
  const options = ["Yes, draft it", "Not yet"];
  for (const said of ["Yes.", "Yeah, go ahead!", "Go ahead", "OK", "Sure, do it"]) assert.equal(spokenOption(said, options), "Yes, draft it", said);
  for (const said of ["No.", "Not yet", "Nope, hold off", "Wait"]) assert.equal(spokenOption(said, options), "Not yet", said);
});

test("an option's own words match; ambiguous or long remarks do not", () => {
  const options = ["Visibility", "Track layout", "Both"];
  assert.equal(spokenOption("Track layout.", options), "Track layout");
  assert.equal(spokenOption("Let's go with both", options), "Both");
  assert.equal(spokenOption("Yes", options), undefined, "no option reads as yes");
  assert.equal(spokenOption("I think the visibility thing is related to the track layout problem we saw last week", options), undefined);
  assert.equal(spokenOption("visibility and track layout", ["Visibility", "Track layout"]), undefined, "two options named");
  assert.equal(spokenOption("", options), undefined);
});

test("generic yes/no needs a short reply with nothing else in it", () => {
  const options = ["Yes, draft it", "Not yet"];
  assert.equal(spokenOption("ok so where were we", options), undefined);
  assert.equal(spokenOption("sure, but what about the budget", options), undefined);
  assert.equal(spokenOption("yeah go ahead", options), "Yes, draft it");
});
