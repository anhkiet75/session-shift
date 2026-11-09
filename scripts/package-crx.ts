#!/usr/bin/env node
import {
  type KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readVersion as readSourceVersion, readJsonObject } from './release-version.js';
import { readExtensionZip } from './extension-zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const RELEASES = path.join(ROOT, "releases");
const SIGNATURE_CONTEXT = Buffer.from("CRX3 SignedData\u0000", "utf8");

function fail(message: string): never {
  throw new Error(message);
}

function encodeVarint(value: number) {
  const bytes = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function encodeLengthDelimitedField(fieldNumber: number, payload: Uint8Array) {
  return Buffer.concat([
    encodeVarint(fieldNumber * 8 + 2),
    encodeVarint(payload.length),
    payload,
  ]);
}

function formatExtensionId(crxId: Uint8Array) {
  const alphabet = "abcdefghijklmnop";
  let id = "";
  for (const byte of crxId) {
    id += alphabet[byte >> 4] + alphabet[byte & 0x0f];
  }
  return id;
}

function readVersion() {
  const manifestPath = path.join(DIST, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail("dist/manifest.json is missing. Run npm run build before packaging the CRX.");
  }
  const manifest = readJsonObject(manifestPath);
  if (typeof manifest.version !== "string" || !/^\d+(\.\d+){1,3}$/.test(manifest.version)) {
    fail(`dist/manifest.json has an invalid version: ${JSON.stringify(manifest.version)}`);
  }
  const version = readSourceVersion();
  if (manifest.version !== version) fail("Built manifest version does not match package.json");
  return version;
}

function readZip(version: string) {
  const zipPath = process.env.CRX_ZIP_PATH
    ? path.resolve(process.env.CRX_ZIP_PATH)
    : path.join(RELEASES, `session_shift_v${version}.zip`);
  if (!existsSync(zipPath)) {
    fail(`Extension ZIP not found at ${zipPath}. Run npm run package before packaging the CRX.`);
  }
  const archive = readExtensionZip(zipPath, version);
  return archive.buffer;
}

export function loadPrivateKey(requireKey = false) {
  const pem = process.env.CRX_PRIVATE_KEY?.trim();
  const encoded = process.env.CRX_PRIVATE_KEY_BASE64?.trim();
  const keyPath = process.env.CRX_PRIVATE_KEY_PATH?.trim();
  if ([pem, encoded, keyPath].filter(Boolean).length > 1) {
    fail("Set only one of CRX_PRIVATE_KEY, CRX_PRIVATE_KEY_BASE64 or CRX_PRIVATE_KEY_PATH.");
  }
  if (pem) {
    return { key: validateKey(readPrivateKey(pem, "CRX_PRIVATE_KEY")), source: "CRX_PRIVATE_KEY" };
  }
  if (encoded) {
    const pem = Buffer.from(encoded, "base64").toString("utf8");
    if (!pem.includes("PRIVATE KEY")) {
      fail("CRX_PRIVATE_KEY_BASE64 does not decode to a PEM private key.");
    }
    return { key: validateKey(readPrivateKey(pem, "CRX_PRIVATE_KEY_BASE64")), source: "CRX_PRIVATE_KEY_BASE64" };
  }
  if (keyPath) {
    const resolved = path.resolve(keyPath);
    if (!existsSync(resolved)) {
      fail(`CRX_PRIVATE_KEY_PATH does not exist: ${resolved}`);
    }
    if (requireKey) fail("Releases require CRX_PRIVATE_KEY or CRX_PRIVATE_KEY_BASE64");
    return { key: validateKey(readPrivateKey(readFileSync(resolved, "utf8"), "CRX_PRIVATE_KEY_PATH")), source: "CRX_PRIVATE_KEY_PATH" };
  }
  if (requireKey) fail("Releases require CRX_PRIVATE_KEY or CRX_PRIVATE_KEY_BASE64");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { key: privateKey, source: "ephemeral" };
}

function readPrivateKey(pem: string, source: string): KeyObject {
  try {
    return createPrivateKey(pem);
  } catch (error) {
    fail(`${source} is not a valid PEM private key: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateKey(privateKey: KeyObject): KeyObject {
  if (privateKey.asymmetricKeyType !== "rsa") {
    fail(`The CRX signing key must be RSA, received ${privateKey.asymmetricKeyType}.`);
  }
  const modulusLength = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusLength < 2048) {
    fail(`The CRX signing key must use at least 2048 bits, received ${modulusLength}.`);
  }

  return privateKey;
}

export function buildCrx(privateKey: KeyObject, zip: Buffer) {
  validateKey(privateKey);

  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const crxId = createHash("sha256").update(publicKeyDer).digest().subarray(0, 16);
  const signedHeaderData = encodeLengthDelimitedField(1, crxId);

  const signedHeaderLength = Buffer.alloc(4);
  signedHeaderLength.writeUInt32LE(signedHeaderData.length);
  const signedPayload = Buffer.concat([
    SIGNATURE_CONTEXT,
    signedHeaderLength,
    signedHeaderData,
    zip,
  ]);
  const signature = sign("sha256", signedPayload, privateKey);

  const proof = Buffer.concat([
    encodeLengthDelimitedField(1, publicKeyDer),
    encodeLengthDelimitedField(2, signature),
  ]);
  const header = Buffer.concat([
    encodeLengthDelimitedField(2, proof),
    encodeLengthDelimitedField(10000, signedHeaderData),
  ]);

  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "ascii");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return {
    crx: Buffer.concat([prefix, header, zip]),
    extensionId: formatExtensionId(crxId),
  };
}

export function verifyCrx(crxPath: string, expectedExtensionId: string, expectedVersion: string) {
  const crx = readFileSync(crxPath);
  if (crx.length < 12 || crx.subarray(0, 4).toString("ascii") !== "Cr24" || crx.readUInt32LE(4) !== 3) {
    fail(`Generated file is not a CRX3 archive: ${crxPath}`);
  }
  const headerLength = crx.readUInt32LE(8);
  if (headerLength === 0 || 12 + headerLength > crx.length) {
    fail(`Generated CRX3 header length is invalid: ${crxPath}`);
  }
  const header = crx.subarray(12, 12 + headerLength);
  const zip = crx.subarray(12 + headerLength);
  readExtensionZip(zip, expectedVersion);

  const fields = parseFields(header);
  const proofBytes = fields.find(([field]) => field === 2)?.[1];
  if (!proofBytes) fail("Generated CRX3 header has no RSA proof");
  const proof = parseFields(proofBytes);
  const publicKeyDer = proof.find(([field]) => field === 1)?.[1];
  const signature = proof.find(([field]) => field === 2)?.[1];
  const signedHeaderData = fields.find(([field]) => field === 10000)?.[1];
  if (!publicKeyDer || !signature || !signedHeaderData) {
    fail("Generated CRX3 header is incomplete.");
  }

  const crxId = createHash("sha256").update(publicKeyDer).digest().subarray(0, 16);
  if (formatExtensionId(crxId) !== expectedExtensionId) {
    fail("Generated CRX extension ID does not match its public key.");
  }
  const signedHeaderFields = parseFields(signedHeaderData);
  const signedCrxId = signedHeaderFields.find(([field]) => field === 1)?.[1];
  if (!signedCrxId || !signedCrxId.equals(crxId)) {
    fail("Generated CRX signed header ID does not match its public key.");
  }
  const signedHeaderLength = Buffer.alloc(4);
  signedHeaderLength.writeUInt32LE(signedHeaderData.length);
  const signedPayload = Buffer.concat([
    SIGNATURE_CONTEXT,
    signedHeaderLength,
    signedHeaderData,
    zip,
  ]);
  const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "rsa" || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    fail("Generated CRX public key is not an RSA key of at least 2048 bits.");
  }
  if (!verifySignature(signedPayload, publicKey, signature)) {
    fail("Generated CRX signature failed verification.");
  }
}

function parseFields(buffer: Buffer): [number, Buffer][] {
  const fields: [number, Buffer][] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const [tag, tagEnd] = readVarint(buffer, offset);
    offset = tagEnd;
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (fieldNumber === 0) fail("Invalid protobuf field number 0 in CRX header.");
    if (wireType === 2) {
      const [length, lengthEnd] = readVarint(buffer, offset);
      offset = lengthEnd;
      if (length > buffer.length - offset) {
        fail(`Truncated protobuf field ${fieldNumber} in CRX header.`);
      }
      fields.push([fieldNumber, buffer.subarray(offset, offset + length)]);
      offset += length;
    } else if (wireType === 0) {
      const [value] = readVarint(buffer, offset);
      fail("Unexpected scalar field in CRX header: " + fieldNumber + ": " + value);
    } else {
      fail(`Unsupported protobuf wire type ${wireType} in CRX header.`);
    }
  }
  return fields;
}

function readVarint(buffer: Buffer, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let index = offset;
  for (;;) {
    if (index >= buffer.length || index - offset >= 10) {
      fail("Truncated varint in CRX header.");
    }
    const byte = buffer[index++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!Number.isSafeInteger(value)) fail("Varint exceeds the safe integer range in CRX header.");
    if ((byte & 0x80) === 0) {
      return [value, index];
    }
    shift += 7;
    if (shift >= 63) fail("Varint is too long in CRX header.");
  }
}

function verifySignature(payload: Buffer, publicKey: KeyObject, signature: Buffer) {
  try {
    return verify("sha256", payload, publicKey, signature);
  } catch {
    return false;
  }
}

export function main() {
  const version = readVersion();
  const zip = readZip(version);
  const { key, source } = loadPrivateKey(process.env.CRX_REQUIRE_KEY === "1");
  const { crx, extensionId } = buildCrx(key, zip);

  mkdirSync(RELEASES, { recursive: true });
  const crxPath = path.join(RELEASES, `session_shift_v${version}.crx`);
  writeFileSync(crxPath, crx);
  verifyCrx(crxPath, extensionId, version);

  if (source === "ephemeral") {
    console.warn(
      "Warning: no CRX signing key was provided, so this build uses a temporary key " +
        "and its extension ID will change on every run."
    );
  }
  console.log(`CRX: ${crxPath} (${statSync(crxPath).size} bytes)`);
  console.log(`Extension ID: ${extensionId}`);
  console.log(`Signing key: ${source}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`package-crx: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
