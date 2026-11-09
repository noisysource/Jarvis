// Numbers read out in words, just before text goes to a voice (#92): "366"
// becomes "three hundred sixty-six", for any brain and any voice. The chat
// keeps the digits; only what's spoken changes. English only for now; other
// languages are left as they are.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = [
  [1_000_000_000_000, "trillion"],
  [1_000_000_000, "billion"],
  [1_000_000, "million"],
  [1_000, "thousand"],
];

/** 0–99. @param {number} n */
const underHundred = (n) => {
  if (n < 20) return ONES[n] ?? "";
  const ones = n % 10;
  return `${TENS[Math.floor(n / 10)] ?? ""}${ones ? `-${ONES[ones]}` : ""}`;
};

/** 0–999. @param {number} n */
const underThousand = (n) => {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return underHundred(rest);
  return `${ONES[hundreds]} hundred${rest ? ` ${underHundred(rest)}` : ""}`;
};

/**
 * A whole number in words: 366 → "three hundred sixty-six".
 * @param {number} n a non-negative safe integer
 * @returns {string}
 */
export const integerWords = (n) => {
  if (n === 0) return "zero";
  const parts = [];
  let rest = n;
  for (const [size, name] of SCALES) {
    const count = Math.floor(rest / /** @type {number} */ (size));
    if (count > 0) {
      parts.push(`${integerWords(count)} ${name}`);
      rest %= /** @type {number} */ (size);
    }
  }
  if (rest > 0) parts.push(underThousand(rest));
  return parts.join(" ");
};

/**
 * A year the way it's said: 1984 → "nineteen eighty-four", 2026 → "twenty
 * twenty-six", 2005 → "two thousand five", 1900 → "nineteen hundred".
 * @param {number} y 1100–2099
 */
export const yearWords = (y) => {
  if (y >= 2000 && y < 2010) return integerWords(y);
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (lo === 0) return `${underHundred(hi)} hundred`;
  return `${underHundred(hi)} ${lo < 10 ? `oh ${ONES[lo]}` : underHundred(lo)}`;
};

const ORDINAL_WORDS = /** @type {Record<string, string>} */ ({
  one: "first",
  two: "second",
  three: "third",
  five: "fifth",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
});

/** 21 → "twenty-first". @param {number} n */
export const ordinalWords = (n) => {
  const words = integerWords(n);
  const match = /([a-z]+)$/.exec(words);
  const last = match?.[1] ?? "";
  const head = words.slice(0, words.length - last.length);
  const ordinal = ORDINAL_WORDS[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return head + ordinal;
};

/** Digits after a decimal point, one by one: "05" → "zero five". @param {string} digits */
const digitWords = (digits) => [...digits].map((d) => ONES[Number(d)] ?? "").join(" ");

const CURRENCY = /** @type {Record<string, [string, string]>} */ ({
  "€": ["euro", "euros"],
  $: ["dollar", "dollars"],
  "£": ["pound", "pounds"],
});

/** "a" or "p" → "a m" / "p m". @param {string} ap */
const meridiem = (ap) => (ap.toLowerCase() === "a" ? "a m" : "p m");

/**
 * A number with its decimals: "3.5" → "three point five".
 * @param {string} whole digits, maybe with thousands commas @param {string | undefined} decimals
 */
const numberWords = (whole, decimals) => {
  const n = Number(whole.replace(/,/g, ""));
  if (!Number.isSafeInteger(n)) return null;
  return `${integerWords(n)}${decimals ? ` point ${digitWords(decimals)}` : ""}`;
};

/**
 * Every number in a sentence, in words, ready for a voice. Handles money
 * (€5, $3.50), percentages, ordinals (21st), times (9:30, 6 pm), years
 * (1984, 2026), thousands commas, decimals and minus signs. Anything it
 * can't read is left as it is.
 * @param {string} text @param {string} [language] "en" (anything else is returned unchanged)
 */
export const speakableNumbers = (text, language = "en") => {
  if (language !== "en" || !/\d/.test(text)) return text;
  return (
    text
      // Money: €5, $3.50, £1,200
      .replace(/([€$£])\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b/g, (all, sign, whole, cents) => {
        const names = CURRENCY[sign];
        const n = Number(String(whole).replace(/,/g, ""));
        if (!names || !Number.isSafeInteger(n)) return all;
        const main = `${integerWords(n)} ${n === 1 ? names[0] : names[1]}`;
        const c = cents ? Number(String(cents).padEnd(2, "0")) : 0;
        return c > 0 ? `${main} ${integerWords(c)}` : main;
      })
      // Times: 9:30, 18:05, 9:00 am
      .replace(/\b([01]?\d|2[0-3]):([0-5]\d)(?:\s?([ap])\.?m\b\.?)?/gi, (_all, h, m, ap) => {
        const hour = integerWords(Number(h));
        const minutes = Number(m);
        const time = minutes === 0 ? (ap ? hour : `${hour} o'clock`) : `${hour} ${minutes < 10 ? `oh ${ONES[minutes]}` : underHundred(minutes)}`;
        return ap ? `${time} ${meridiem(ap)}` : time;
      })
      // 6 pm, 7am, 5 a.m.
      .replace(/\b(1[0-2]|0?[1-9])\s?([ap])\.?m\b\.?/gi, (_all, h, ap) => `${integerWords(Number(h))} ${meridiem(ap)}`)
      // Ordinals: 1st, 22nd, 103rd
      .replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, (all, n) => (Number.isSafeInteger(Number(n)) ? ordinalWords(Number(n)) : all))
      // Percentages: 50%, 2.5 %
      .replace(/(-?)\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s?%/g, (all, minus, whole, dec) => {
        const words = numberWords(whole, dec);
        return words ? `${minus ? "minus " : ""}${words} percent` : all;
      })
      // Years: four digits from 1100 to 2099 on their own (not money, not with commas or decimals)
      .replace(/(?<![\d.,])\b(1[1-9]\d\d|20\d\d)\b(?![.,]\d)/g, (_all, y) => yearWords(Number(y)))
      // Everything else: -3, 1,200, 3.14
      .replace(/(?<![\w.])(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\d])/g, (all, minus, whole, dec) => {
        const words = numberWords(whole, dec);
        return words ? `${minus ? "minus " : ""}${words}` : all;
      })
  );
};
