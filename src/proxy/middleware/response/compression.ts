import util from "util";
import zlib from "zlib";
import { PassThrough } from "stream";

const BUFFER_DECODER_MAP = {
  gzip: util.promisify(zlib.gunzip),
  deflate: util.promisify(zlib.inflate),
  br: util.promisify(zlib.brotliDecompress),
  text: (data: Buffer) => data,
};

const STREAM_DECODER_MAP = {
  gzip: zlib.createGunzip,
  deflate: zlib.createInflate,
  br: zlib.createBrotliDecompress,
  text: () => new PassThrough(),
};

type SupportedContentEncoding = keyof typeof BUFFER_DECODER_MAP;
const isSupportedContentEncoding = (
  encoding: string
): encoding is SupportedContentEncoding => encoding in BUFFER_DECODER_MAP;

export async function decompressBuffer(buf: Buffer, encoding: string = "text") {
  if (isSupportedContentEncoding(encoding)) {
    return (await BUFFER_DECODER_MAP[encoding](buf)).toString();
  }
  throw new Error(`Unsupported content-encoding: ${encoding}`);
}

export function getStreamDecompressor(encoding: string = "text") {
  if (isSupportedContentEncoding(encoding)) {
    return STREAM_DECODER_MAP[encoding]();
  }
  throw new Error(`Unsupported content-encoding: ${encoding}`);
}
