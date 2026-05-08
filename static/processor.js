class AudioInProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        var opts = options.processorOptions || {};
        var inRate = opts.inputSampleRate || sampleRate;
        var outRate = opts.outputSampleRate || 16000;
        this._ratio = inRate / outRate;
        this._buffer = [];
    }

    process(inputs, outputs, parameters) {
        var input = inputs[0];
        if (!input || !input[0] || input[0].length === 0) return true;

        var samples = input[0];
        for (var i = 0; i < samples.length; i += this._ratio) {
            this._buffer.push(samples[Math.floor(i)]);
        }

        var CHUNK = 512;
        while (this._buffer.length >= CHUNK) {
            // console.log("Processing chunk of audio data...");
            var chunk = this._buffer.splice(0, CHUNK);
            var int16 = new Int16Array(CHUNK);
            for (var j = 0; j < CHUNK; j++) {
                var s = Math.max(-1, Math.min(1, chunk[j]));
                int16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            // console.log("Posting audio chunk to main thread...");
            this.port.postMessage(int16.buffer, [int16.buffer]);
        }
        return true;
    }
}

registerProcessor('audio-in-processor', AudioInProcessor);
