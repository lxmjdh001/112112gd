import type { Fingerprint } from "../shared/fingerprint.ts";

// Serialized into the page's main world before its scripts run. No Electron or
// Node access is exposed. The seed belongs to the account, never a page load.
export function installFingerprintPage(p: Fingerprint, origins: string[]) {
  const origin =
    location.protocol === "chrome-extension:"
      ? `${location.protocol}//${location.host}`
      : location.origin;
  if (!origins.includes(origin)) return;
  const patch = (target: object, key: string, value: unknown) =>
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  Object.defineProperty(Navigator.prototype, "deviceMemory", {
    configurable: true,
    get: () => p.deviceMemory,
  });
  Object.defineProperty(Navigator.prototype, "languages", {
    configurable: true,
    get: () => Object.freeze([...new Set([p.language, p.language.split("-")[0]])]),
  });
  if (p.webrtc === "disabled") {
    const disabled = function () {
      throw new DOMException("WebRTC is disabled for this account", "NotAllowedError");
    };
    patch(window, "RTCPeerConnection", disabled);
    if ("webkitRTCPeerConnection" in window) patch(window, "webkitRTCPeerConnection", disabled);
  }
  if (p.blockLocalFonts && window.FontFace) {
    // CDP controls CSS rendering; JS-created FontFace instances need a separate
    // local-source guard. Downloaded and in-memory fonts retain normal behavior.
    const Font = window.FontFace;
    patch(
      window,
      "FontFace",
      new Proxy(Font, {
        construct(target, args, newTarget) {
          const source = args[1];
          if (typeof source === "string" && /\blocal\s*\(/i.test(source))
            args[1] = 'url("data:font/woff2;base64,")';
          return Reflect.construct(target, args, newTarget);
        },
      }),
    );
  }
  const seed = parseInt(p.seed.slice(0, 8), 16) >>> 0;
  const perturb = (data: Uint8Array | Uint8ClampedArray) => {
    if (data.length < 4) return;
    // Alter at most 32 RGB samples, keeping alpha and original backing stores.
    for (let n = 0; n < Math.min(32, Math.floor(data.length / 4)); n++) {
      const index =
        ((Math.imul(seed ^ (n + 1), 2654435761) >>> 0) % Math.floor(data.length / 4)) * 4 + (n % 3);
      data[index] = Math.max(0, Math.min(255, data[index]! + ((seed >>> (n % 24)) & 1 ? 1 : -1)));
    }
  };
  for (const Context of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Context) continue;
    const proto = Context.prototype;
    if (p.gpuRenderer) {
      const get = proto.getParameter;
      patch(proto, "getParameter", function (this: WebGLRenderingContext, parameter: number) {
        if (parameter === 37445) return p.gpuVendor;
        if (parameter === 37446) return p.gpuRenderer;
        return get.call(this, parameter);
      });
    }
    if (p.webglNoise) {
      const read = proto.readPixels;
      patch(proto, "readPixels", function (this: WebGLRenderingContext, ...args: any[]) {
        const value = Reflect.apply(read, this, args);
        const pixels = args[6];
        if (args[4] === 6408 && args[5] === 5121 && pixels instanceof Uint8Array) {
          const offset = typeof args[7] === "number" ? args[7] : 0;
          perturb(pixels.subarray(offset, offset + args[2] * args[3] * 4));
        }
        return value;
      });
    }
  }
  if (p.canvasNoise) {
    const context = CanvasRenderingContext2D.prototype;
    const read = context.getImageData;
    patch(
      context,
      "getImageData",
      function (this: CanvasRenderingContext2D, ...args: Parameters<typeof read>) {
        const pixels = Reflect.apply(read, this, args) as ImageData;
        perturb(pixels.data);
        return pixels;
      },
    );
    const copy = (canvas: HTMLCanvasElement) => {
      if (!canvas.width || !canvas.height || canvas.width * canvas.height > 16_777_216)
        return canvas;
      const clone = document.createElement("canvas");
      clone.width = canvas.width;
      clone.height = canvas.height;
      const ctx = clone.getContext("2d")!;
      ctx.drawImage(canvas, 0, 0);
      const pixels = read.call(ctx, 0, 0, clone.width, clone.height);
      perturb(pixels.data);
      ctx.putImageData(pixels, 0, 0);
      return clone;
    };
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    patch(
      HTMLCanvasElement.prototype,
      "toDataURL",
      function (this: HTMLCanvasElement, ...args: Parameters<typeof toDataURL>) {
        return Reflect.apply(toDataURL, copy(this), args);
      },
    );
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    patch(
      HTMLCanvasElement.prototype,
      "toBlob",
      function (this: HTMLCanvasElement, ...args: Parameters<typeof toBlob>) {
        return Reflect.apply(toBlob, copy(this), args);
      },
    );
  }
  if (p.audioNoise && window.AudioBuffer) {
    const read = AudioBuffer.prototype.getChannelData;
    const copy = AudioBuffer.prototype.copyFromChannel;
    const modified = new WeakMap<AudioBuffer, Set<number>>();
    const apply = (buffer: AudioBuffer, channel: number) => {
      const data = read.call(buffer, channel);
      const channels = modified.get(buffer) || new Set<number>();
      if (!channels.has(channel)) {
        for (let n = 0; n < Math.min(16, data.length); n++) {
          const i = (Math.imul(seed ^ (n + 1), 2246822519) >>> 0) % data.length;
          data[i] += ((seed >>> (n % 24)) & 1 ? 1 : -1) * 1e-7;
        }
        channels.add(channel);
        modified.set(buffer, channels);
      }
      return data;
    };
    patch(AudioBuffer.prototype, "getChannelData", function (this: AudioBuffer, channel: number) {
      return apply(this, channel);
    });
    patch(
      AudioBuffer.prototype,
      "copyFromChannel",
      function (
        this: AudioBuffer,
        destination: Float32Array<ArrayBuffer>,
        channel: number,
        start?: number,
      ) {
        apply(this, channel);
        return copy.call(this, destination, channel, start);
      },
    );
  }
}
