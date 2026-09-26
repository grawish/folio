"""Folio brag soundtrack: one piece in D major, 104 BPM, music + effects in one space."""
import numpy as np
import wave

SR = 44100
DUR = 22.4
N = int(SR * DUR)
rng = np.random.default_rng(7)
BEAT = 60 / 104
BAR = BEAT * 4


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def buf():
    return np.zeros((2, N))


def place(bus, sig, t, gain=1.0, pan=0.0):
    i = int(t * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    bus[0, i:i + len(sig)] += sig * gain * l * 1.414
    bus[1, i:i + len(sig)] += sig * gain * r * 1.414


def env(n, a, d_tau):
    t = np.arange(n) / SR
    return np.minimum(1, t / max(a, 1e-4)) * np.exp(-t / d_tau)


def pluck(m, dur=0.9, bright=0.35):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m)
    s = sum((bright ** (k - 1)) / k * np.sin(2 * np.pi * f * k * t) * np.exp(-t * (3 + k * 2.5)) for k in range(1, 6))
    return s * np.minimum(1, t / 0.004)


def bell(m, dur=1.6):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m)
    s = np.sin(2 * np.pi * f * t) * np.exp(-t * 2.6) + .35 * np.sin(2 * np.pi * f * 2.0 * t) * np.exp(-t * 5) \
        + .12 * np.sin(2 * np.pi * f * 3.01 * t) * np.exp(-t * 9)
    return s * np.minimum(1, t / 0.006)


def pad_voice(m, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m)
    s = np.zeros(n)
    for det in (-0.12, 0, 0.11):
        ff = f * 2 ** (det / 12)
        for k, a in ((1, 1), (2, .32), (3, .12), (4, .05)):
            s += a * np.sin(2 * np.pi * ff * k * t + rng.uniform(0, 6))
    fade = np.minimum(1, t / 0.45) * np.minimum(1, (dur - t) / 0.5)
    return s / 3 * np.clip(fade, 0, 1)


def kick():
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 45 + 75 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 8.5) * np.minimum(1, t / 0.002)


def shaped_noise(n, lo, hi):
    x = rng.standard_normal(n)
    X = np.fft.rfft(x)
    fr = np.fft.rfftfreq(n, 1 / SR)
    X *= ((fr > lo) & (fr < hi)) * 1.0
    y = np.fft.irfft(X, n)
    return y / (np.abs(y).max() + 1e-9)


def hat():
    n = int(0.08 * SR)
    return shaped_noise(n, 7000, 14000) * np.exp(-np.arange(n) / SR * 60)


def whoosh(dur=0.7, rise=0.5, lo=400, hi=5000):
    n = int(dur * SR)
    t = np.arange(n) / SR
    e = np.where(t < rise, (t / rise) ** 2, np.exp(-(t - rise) * 9))
    return shaped_noise(n, lo, hi) * e


def tick():
    n = int(0.035 * SR)
    t = np.arange(n) / SR
    return (shaped_noise(n, 1500, 6000) * .5 + np.sin(2 * np.pi * 1900 * t)) * np.exp(-t * 180)


def click():
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * hz(86) * t) * .7 + shaped_noise(n, 800, 5000) * .3) * np.exp(-t * 55)


def reverb(x, secs=2.4, mix=0.28):
    n = int(secs * SR)
    t = np.arange(n) / SR
    out = np.zeros_like(x)
    for c in range(2):
        ir = shaped_noise(n, 200, 9000) * np.exp(-t * 3.2)
        ir[: int(0.012 * SR)] = 0
        L = len(x[c]) + n
        size = 1 << (L - 1).bit_length()
        y = np.fft.irfft(np.fft.rfft(x[c], size) * np.fft.rfft(ir, size), size)[: len(x[c])]
        out[c] = y / np.abs(ir).sum() * 18
    return x * (1 - mix) + out * mix


music, fx = buf(), buf()

# chords (D major): D Bm G A, one per bar; outro resolves to Dmaj9 at 19.4
CH = {'D': [50, 57, 62, 66, 69], 'Bm': [47, 54, 62, 66, 71], 'G': [43, 55, 59, 62, 67], 'A': [45, 57, 61, 64, 69]}
order = ['D', 'Bm', 'G', 'A'] * 3
OUTRO = 19.4
t = 0.0
bar_i = 0
while t < OUTRO:
    name = order[bar_i]
    d = min(BAR, OUTRO - t) + 0.5
    for m in CH[name][1:]:
        place(music, pad_voice(m, d), t, 0.055, pan=rng.uniform(-.5, .5))
    place(music, pad_voice(CH[name][0] - 12, d), t, 0.09)
    # arpeggio: quarters in the intro, eighths once the app is on screen
    step = BEAT if t < 6.0 else BEAT / 2
    k = 0
    tt = t
    while tt < t + BAR - 1e-6 and tt < OUTRO - 0.05:
        notes = CH[name][1:] + [CH[name][2] + 12]
        m = notes[[0, 2, 1, 3, 2, 4, 3, 1][k % 8]] + 12
        vel = 0.07 if k % 2 == 0 else 0.05
        place(music, pluck(m), tt, vel, pan=0.35 if k % 2 else -0.35)
        tt += step
        k += 1
    t += BAR
    bar_i += 1

# groove from the app reveal to the outro
bt = 6.15
i = 0
while bt < OUTRO - 0.1:
    place(music, kick(), bt, 0.21)
    if i % 2 == 1:
        place(music, hat(), bt, 0.024, pan=0.2)
    place(music, hat(), bt + BEAT / 2, 0.014, pan=-0.2)
    bt += BEAT
    i += 1

# outro bloom: Dmaj9
for m, g in ((38, .10), (50, .07), (57, .06), (61, .05), (64, .05), (66, .05), (69, .045), (73, .04)):
    place(music, pad_voice(m, DUR - OUTRO + 0.1), OUTRO, g, pan=rng.uniform(-.4, .4))
place(music, kick(), OUTRO, 0.30)
for j, m in enumerate([74, 78, 81, 85]):
    place(music, bell(m, 2.5), OUTRO + 0.1 + j * 0.12, 0.05, pan=(j - 1.5) * .3)

# ---- effects, tuned to the key and sent into the same room ----
place(fx, whoosh(0.9, 0.7, 600, 6000), 0.4, 0.033)             # box drag
place(fx, bell(86), 1.3, 0.07, pan=.2)                         # badge "1" pops (D6)
place(fx, whoosh(0.6, 0.35, 300, 4000), 3.15, 0.046)            # to wordmark
for j, m in enumerate([62, 69, 74, 78]):                       # wordmark bloom
    place(fx, bell(m, 2.2), 3.55 + j * 0.05, 0.035, pan=(j - 1.5) * .3)
place(fx, whoosh(0.6, 0.35, 300, 4000), 5.8, 0.039)             # to app
for ct in (7.3, 9.7, 17.05):                                  # clicks
    place(fx, click(), ct, 0.07)
PROMPT = 'Lead with the 28% and keep it to two lines.'
for c in range(len(PROMPT)):                                   # typing, kept far back
    if PROMPT[c] != ' ':
        tt = 7.6 + (9.25 - 7.6) * c / len(PROMPT) + rng.uniform(-0.01, 0.01)
        place(fx, tick(), tt, 0.012 + rng.uniform(0, 0.006), pan=rng.uniform(-.2, .2))
for st, m in zip([10.6, 11.15, 11.7, 12.25], [81, 83, 85, 86]):  # progress ticks: A B C# D
    place(fx, bell(m), st, 0.05, pan=.15)
place(fx, whoosh(0.8, 0.2, 2000, 9000), 11.65, 0.019)           # PDF swap shimmer
place(fx, whoosh(0.8, 0.6, 400, 5000), 13.6, 0.026)             # zoom in
place(fx, whoosh(0.7, 0.45, 400, 5000), 15.8, 0.023)           # zoom out
place(fx, whoosh(0.6, 0.35, 300, 4000), 19.0, 0.033)            # to outro

mix = music + fx
mix = reverb(mix, mix=0.3)
# gentle fade in/out
tt = np.arange(N) / SR
mix *= np.minimum(1, tt / 0.05) * np.clip((DUR - tt) / 1.6, 0, 1)
mix = np.tanh(mix * 1.6) / 1.6
mix /= np.abs(mix).max() / 0.89

with wave.open('brag-output/work/soundtrack.wav', 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix.T * 32767).astype('<i2').tobytes())
print('ok')
