import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction";
import { PublicKey } from "@qubic-lib/qubic-ts-library/dist/qubic-types/PublicKey";
import { Long } from "@qubic-lib/qubic-ts-library/dist/qubic-types/Long";
import { DynamicPayload } from "@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload";
import { Signature } from "@qubic-lib/qubic-ts-library/dist/qubic-types/Signature";
import { PUBLIC_KEY_LENGTH, SIGNATURE_LENGTH } from "@qubic-lib/qubic-ts-library/dist/crypto";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper";

const qHelper = new QubicHelper();

// Convert Uint8Array to hex string
export const byteArrayToHexString = (byteArray: any[]) => {
  const hexString = Array.from(byteArray, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hexString;
};

export const uint8ArrayToBase64 = (uint8Array: Uint8Array): string => {
  const binaryString = String.fromCharCode.apply(null, Array.from(uint8Array));
  return btoa(binaryString);
};

export const base64ToUint8Array = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  return new Uint8Array(binaryString.split("").map((char) => char.charCodeAt(0)));
};

export const createDataView = (size: number): { buffer: ArrayBuffer; view: DataView } => {
  const buffer = new ArrayBuffer(size);
  return { buffer, view: new DataView(buffer) };
};

export const decodeUint8ArrayTx = (tx: Uint8Array) => {
  const new_tx = new QubicTransaction();
  const inputSize =
    new DataView(tx.slice(PUBLIC_KEY_LENGTH * 2 + 14, PUBLIC_KEY_LENGTH * 2 + 16).buffer).getUint16(0, true) || 0;
  const payloadStart = PUBLIC_KEY_LENGTH * 2 + 16;
  const payloadEnd = payloadStart + inputSize;
  const signatureEnd = payloadEnd + SIGNATURE_LENGTH;

  new_tx
    .setSourcePublicKey(new PublicKey(tx.slice(0, PUBLIC_KEY_LENGTH)))
    .setDestinationPublicKey(new PublicKey(tx.slice(PUBLIC_KEY_LENGTH, PUBLIC_KEY_LENGTH * 2)))
    .setAmount(new Long(tx.slice(PUBLIC_KEY_LENGTH * 2, PUBLIC_KEY_LENGTH * 2 + 8)))
    .setTick(new DataView(tx.slice(PUBLIC_KEY_LENGTH * 2 + 8, PUBLIC_KEY_LENGTH * 2 + 12).buffer).getUint32(0, true))
    .setInputType(
      new DataView(tx.slice(PUBLIC_KEY_LENGTH * 2 + 12, PUBLIC_KEY_LENGTH * 2 + 14).buffer).getUint16(0, true),
    )
    .setInputSize(inputSize);

  if (inputSize > 0) {
    const payload = new DynamicPayload(inputSize);
    payload.setPayload(tx.slice(payloadStart, payloadEnd));
    new_tx.setPayload(payload);
  }
  new_tx.signature = new Signature(tx.slice(payloadEnd, signatureEnd));

  return new_tx;
};

interface ICreatePayload {
  data: number | bigint | Uint8Array | string;
  type: "uint8" | "uint16" | "uint32" | "bigint64" | "id";
}

export const createPayload = (data: ICreatePayload[]) => {
  const TYPE_SIZES = {
    uint8: 1,
    uint16: 2,
    uint32: 4,
    bigint64: 8,
    id: 32,
  };

  const totalSize = data.reduce((acc, { type }) => acc + TYPE_SIZES[type], 0);
  const dynamicPayload = new DynamicPayload(totalSize);

  const { buffer, view } = createDataView(totalSize);

  let offset = 0;
  const setters = {
    uint8: (v: DataView, o: number, d: number) => {
      v.setUint8(o, d);
      return 1;
    },
    uint16: (v: DataView, o: number, d: number) => {
      v.setUint16(o, d, true);
      return 2;
    },
    uint32: (v: DataView, o: number, d: number) => {
      v.setUint32(o, d, true);
      return 4;
    },
    bigint64: (v: DataView, o: number, d: number) => {
      v.setBigUint64(o, BigInt(d), true);
      return 8;
    },
    id: (v: DataView, o: number, d: Uint8Array | string) => {
      let bytes: Uint8Array | string;
      if (typeof d === "string") {
        bytes = qHelper.getIdentityBytes(d);
      } else {
        bytes = new Uint8Array(d);
      }
      for (let i = 0; i < 32; i++) {
        v.setUint8(o + i, bytes[i] || 0);
      }
      return 32;
    },
  };

  data.forEach(({ type, data: value }) => {
    if (type === "id") {
      offset += setters[type](view, offset, value as Uint8Array);
    } else {
      offset += setters[type](view, offset, value as number);
    }
  });

  const result = new Uint8Array(buffer);
  dynamicPayload.setPayload(result);

  return dynamicPayload;
};

// (A seed generator that used Math.random was here and was never used; seeds are only ever typed in or read from a vault, never made.)

/**
 * Converts an asset name between string <-> number representation.
 * - If input is a string: encodes as ASCII bytes in *little-endian* order (first char is lowest byte).
 * - If input is a number: decodes as ASCII bytes in *little-endian* order (lowest byte is first char),
 *   and stops at the first null-byte (0), to avoid doubling/trailing chars.
 */
export function assetNameConvert(input: string | number): number | string {
  // String to Number logic
  if (typeof input === "string") {
    if (input.length > 7) {
      throw new Error("Input string is too long");
    }
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    for (let i = 0; i < input.length; i++) {
      view.setUint8(i, input.charCodeAt(i));
    }
    // The Qubic convention (see assetNameToId, little-endian)
    return Number(view.getBigUint64(0, true));
  }
  // Number to String logic
  if (typeof input === "number") {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setBigUint64(0, BigInt(input), true); // little-endian
    let result = "";
    // Reconstruct up to 7 chars; break at first 0 byte (padding)
    for (let i = 0; i < 8; i++) {
      const charCode = view.getUint8(i);
      if (charCode === 0) break;
      result += String.fromCharCode(charCode);
    }
    return result;
  }
  throw new Error("Invalid input type");
}
