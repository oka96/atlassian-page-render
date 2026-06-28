const assert = require("node:assert/strict");
const { inflateRawSync } = require("node:zlib");
const test = require("node:test");

const codec = require("../src/plantuml-codec.js");

function decode6Bit(character) {
  const code = character.charCodeAt(0);

  if (code >= 48 && code <= 57) {
    return code - 48;
  }

  if (code >= 65 && code <= 90) {
    return code - 65 + 10;
  }

  if (code >= 97 && code <= 122) {
    return code - 97 + 36;
  }

  if (character === "-") {
    return 62;
  }

  if (character === "_") {
    return 63;
  }

  throw new Error(`Invalid PlantUML character: ${character}`);
}

function decodeBytes(encoded) {
  const bytes = [];

  for (let index = 0; index < encoded.length; index += 4) {
    const c1 = decode6Bit(encoded[index]);
    const c2 = decode6Bit(encoded[index + 1]);
    const c3 = decode6Bit(encoded[index + 2]);
    const c4 = decode6Bit(encoded[index + 3]);

    bytes.push((c1 << 2) | (c2 >> 4));
    bytes.push(((c2 & 0xf) << 4) | (c3 >> 2));
    bytes.push(((c3 & 0x3) << 6) | c4);
  }

  return Buffer.from(bytes);
}

test("stored deflate PlantUML encoding round-trips through inflateRaw", async () => {
  const source = `@startuml
Alice -> Bob: Hello
Bob --> Alice: Hi
@enduml`;

  const encoded = await codec.encode(source, { method: "stored" });
  const decoded = decodeBytes(encoded);
  const inflated = inflateRawSync(decoded);

  assert.equal(inflated.toString("utf8"), source);
});

test("stored deflate handles inputs larger than one deflate block", () => {
  const source = "@startuml\n" + "Alice -> Bob: Hello\n".repeat(5000) + "@enduml";
  const deflated = codec.deflateStored(new TextEncoder().encode(source));
  const inflated = inflateRawSync(deflated);

  assert.equal(inflated.toString("utf8"), source);
});

test("default PlantUML encoding round-trips through inflateRaw", async () => {
  const source = `@startuml
Client -> Extension: scan page
Extension --> Client: rendered diagram
@enduml`;

  const encoded = await codec.encode(source);
  const decoded = decodeBytes(encoded);
  const inflated = inflateRawSync(decoded);

  assert.equal(inflated.toString("utf8"), source);
});

test("PlantUML alphabet encoder matches the expected 6-bit alphabet", () => {
  const { encode6Bit } = codec._internals;

  assert.equal(encode6Bit(0), "0");
  assert.equal(encode6Bit(9), "9");
  assert.equal(encode6Bit(10), "A");
  assert.equal(encode6Bit(35), "Z");
  assert.equal(encode6Bit(36), "a");
  assert.equal(encode6Bit(61), "z");
  assert.equal(encode6Bit(62), "-");
  assert.equal(encode6Bit(63), "_");
});
