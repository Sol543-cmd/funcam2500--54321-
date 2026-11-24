/* Real-time pitch shifter (two crossfading delay taps). Keeps timing, changes pitch. */
class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1, minValue: 0.2, maxValue: 5, automationRate: 'a-rate' }];
  }
  constructor() {
    super();
    this.N = 1 << 16;
    this.mask = this.N - 1;
    this.buf = new Float32Array(this.N);
    this.w = 0;
    this.W = Math.round(sampleRate * 0.055); // grain window ~55 ms
    this.p = 0;
  }
  read(d) {
    const pos = this.w - d;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    const a = this.buf[i0 & this.mask];
    const b = this.buf[(i0 + 1) & this.mask];
    return a + (b - a) * f;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const o0 = out[0];
    const pit = params.pitch;
    const W = this.W;
    for (let i = 0; i < o0.length; i++) {
      this.buf[this.w & this.mask] = inp ? inp[i] : 0;
      const ratio = pit.length > 1 ? pit[i] : pit[0];
      const p1 = this.p;
      let p2 = p1 + 0.5;
      if (p2 >= 1) p2 -= 1;
      const g1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p1);
      const g2 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p2);
      o0[i] = g1 * this.read(p1 * W + 2) + g2 * this.read(p2 * W + 2);
      let np = this.p + (1 - ratio) / W;
      np -= Math.floor(np);
      this.p = np;
      this.w++;
    }
    for (let c = 1; c < out.length; c++) out[c].set(o0);
    return true;
  }
}
registerProcessor('pitch-shifter', PitchShifter);
