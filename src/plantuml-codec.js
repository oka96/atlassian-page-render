(function plantUmlCodecFactory(globalObject) {
  "use strict";

  const PLANTUML_ALPHABET =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

  function encode6Bit(value) {
    if (value < 0 || value > 63) {
      throw new RangeError("PlantUML 6-bit value out of range");
    }

    return PLANTUML_ALPHABET.charAt(value);
  }

  function encode3Bytes(byte1, byte2, byte3) {
    return (
      encode6Bit(byte1 >> 2) +
      encode6Bit(((byte1 & 0x3) << 4) | (byte2 >> 4)) +
      encode6Bit(((byte2 & 0xf) << 2) | (byte3 >> 6)) +
      encode6Bit(byte3 & 0x3f)
    );
  }

  function encodeBytes(bytes) {
    let encoded = "";

    for (let index = 0; index < bytes.length; index += 3) {
      encoded += encode3Bytes(
        bytes[index],
        bytes[index + 1] || 0,
        bytes[index + 2] || 0
      );
    }

    return encoded;
  }

  function toUtf8Bytes(text) {
    return new TextEncoder().encode(text);
  }

  function createStoredDeflateBlock(inputBytes, start, end, isFinal) {
    const blockLength = end - start;
    const output = new Uint8Array(5 + blockLength);
    output[0] = isFinal ? 0x01 : 0x00;
    output[1] = blockLength & 0xff;
    output[2] = (blockLength >> 8) & 0xff;
    output[3] = (~blockLength) & 0xff;
    output[4] = ((~blockLength) >> 8) & 0xff;
    output.set(inputBytes.subarray(start, end), 5);
    return output;
  }

  function concatUint8Arrays(chunks, totalLength) {
    const output = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }

    return output;
  }

  function deflateStored(inputBytes) {
    const maxBlockLength = 0xffff;

    if (inputBytes.length === 0) {
      return createStoredDeflateBlock(inputBytes, 0, 0, true);
    }

    const chunks = [];
    let totalLength = 0;

    for (let start = 0; start < inputBytes.length; start += maxBlockLength) {
      const end = Math.min(start + maxBlockLength, inputBytes.length);
      const isFinal = end === inputBytes.length;
      const chunk = createStoredDeflateBlock(inputBytes, start, end, isFinal);
      chunks.push(chunk);
      totalLength += chunk.length;
    }

    return concatUint8Arrays(chunks, totalLength);
  }

  async function deflateWithCompressionStream(inputBytes) {
    if (typeof CompressionStream !== "function") {
      return null;
    }

    try {
      const stream = new CompressionStream("deflate-raw");
      const writer = stream.writable.getWriter();
      const response = new Response(stream.readable);
      const compressedBytes = response.arrayBuffer();

      await writer.write(inputBytes);
      await writer.close();

      return new Uint8Array(await compressedBytes);
    } catch (_error) {
      return null;
    }
  }

  async function encode(text, options) {
    const settings = options || {};
    const inputBytes = toUtf8Bytes(text);
    const deflated =
      settings.method === "stored"
        ? deflateStored(inputBytes)
        : (await deflateWithCompressionStream(inputBytes)) ||
          deflateStored(inputBytes);

    return encodeBytes(deflated);
  }

  const api = {
    encode,
    encodeBytes,
    deflateStored,
    _internals: {
      encode3Bytes,
      encode6Bit,
      toUtf8Bytes
    }
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalObject.PlantUmlCodec = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
