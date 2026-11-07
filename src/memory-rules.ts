// The memory rules, enforced in code (#61). The extraction prompt states the
// same rules, but these checks run on every suggestion whatever the model
// said, so the prompt is never the only line of defence.
//
// All matching is on whole words, ignoring case and accents, in English and
// Portuguese. Pure functions: no I/O.

import { makeCueMatcher } from "./precheck.js";
import type { Context } from "./types.js";

/** Lowercase words without accents. "Lembra-te, NÃO te esqueças!" → ["lembra", "te", "nao", "te", "esquecas"]. */
export const foldWords = (text: string): string[] =>
  text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);

const phrase = (p: string): readonly string[] => foldWords(p);

/** Index where `needle` starts in `words`, or -1. */
const findPhrase = (words: readonly string[], needle: readonly string[], from = 0): number => {
  for (let i = from; i + needle.length <= words.length; i += 1) {
    if (needle.every((w, j) => words[i + j] === w)) return i;
  }
  return -1;
};

/** "don't", "do not", "never", "não", "nunca", and "you" (as in "do you remember…?", a question, not a request). */
const NEGATORS = new Set(["not", "t", "never", "nao", "nunca", "you"]);

/** Every occurrence of the phrase that isn't directly negated. */
const hasPlainPhrase = (words: readonly string[], needle: readonly string[]): boolean => {
  for (let i = findPhrase(words, needle); i !== -1; i = findPhrase(words, needle, i + 1)) {
    const before = words[i - 1];
    if (before === undefined || !NEGATORS.has(before)) return true;
  }
  return false;
};

/**
 * Words that make a request to remember explicit. "não te esqueças" and
 * "don't forget" are matched as whole phrases, so their own "não"/"don't"
 * doesn't count as negation.
 */
export const REMEMBER_PHRASES: readonly string[] = [
  "remember",
  "take note",
  "lembra",
  "lembre",
  "guarda",
  "anota",
  "não te esqueças",
  "don't forget",
  "do not forget",
];

const PROTECTED_PHRASES = ["não te esqueças", "don't forget", "do not forget"].map(phrase);

/**
 * Did the user, in their own words, ask Jarvis to remember something? The
 * model's "explicit" flag only counts when this is true. "Don't remember
 * this" and "do you remember…?" are not requests to remember.
 */
export const asksToRemember = (question: string): boolean => {
  const words = foldWords(question);
  if (PROTECTED_PHRASES.some((p) => findPhrase(words, p) !== -1)) return true;
  return REMEMBER_PHRASES.map(phrase)
    .filter((p) => !PROTECTED_PHRASES.some((q) => q.join(" ") === p.join(" ")))
    .some((p) => hasPlainPhrase(words, p));
};

const FORGET_PHRASES = ["forget", "esquece", "esqueca", "esquecer", "apaga", "apague", "delete", "remove", "erase"].map(phrase);

/** Did the user ask Jarvis to forget something? Deletes are only allowed when they did. "Don't forget" isn't one. */
export const asksToForget = (question: string): boolean => {
  const words = foldWords(question);
  return FORGET_PHRASES.some((p) => hasPlainPhrase(words, p));
};

// ---- secrets: never kept, not even on an explicit request ----

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** A long run of letters and digits mixed, like an API key or token. */
const looksLikeToken = (text: string): boolean =>
  (text.match(/[A-Za-z0-9_+/=-]{32,}/g) ?? []).some((t) => /[A-Za-z]/.test(t) && /\d/.test(t));

const SECRET_WORDS = [
  "password", "passwords", "passwd", "passcode", "pin", "pin code", "cvv", "cvc", "otp", "2fa", "recovery code",
  "security code", "api key", "secret key", "access token", "palavra passe", "palavra-passe", "senha", "senhas",
  "codigo pin", "código de acesso", "codigo de seguranca",
].map(phrase);

const luhnValid = (digits: string): boolean => {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

/** 13 to 19 digits (spaces or dashes allowed) that pass the card checksum. */
const looksLikeCardNumber = (text: string): boolean =>
  (text.match(/\b\d(?:[ -]?\d){12,18}\b/g) ?? []).some((m) => luhnValid(m.replace(/[ -]/g, "")));

const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/;

export const containsSecret = (text: string): boolean => {
  if (SECRET_PATTERNS.some((p) => p.test(text)) || looksLikeToken(text) || looksLikeCardNumber(text) || IBAN.test(text)) {
    return true;
  }
  const words = foldWords(text);
  return SECRET_WORDS.some((p) => findPhrase(words, p) !== -1);
};

// ---- business records: never kept from a business context ----

const AMOUNT = /€\s?\d|\b\d[\d.,]*\s?(?:€|eur|euros?)\b|\$\s?\d/i;
const DOCUMENT_NUMBER =
  /\b(?:FT|FR|FS|NC|ND|RG|GT|FA)\s?[A-Z0-9]*\s?\d{2,4}\/\d+\b|\b(?:invoice|fatura|factura|recibo|receipt|documento|document|order|encomenda)\s*(?:n\.?º|no\.?|nr\.?|number|número|numero|#)?\s*[A-Z]{0,3}[-/ ]?\d{2,}|#\d{3,}/i;
const TAX_NUMBER = /\b(?:PT\s?)?\d{9}\b/;
const CUSTOMER_WORDS = ["client", "clients", "cliente", "clientes", "customer", "customers", "parents", "pais", "families", "familias", "students", "alunos"].map(phrase);
const NAME_LIST = /\p{Lu}\p{Ll}+(?:\s\p{Lu}\p{Ll}+)?(?:\s*,\s*\p{Lu}\p{Ll}+(?:\s\p{Lu}\p{Ll}+)?){2,}/u;

/** Invoice or document numbers, amounts, tax numbers (NIF) or lists of customers: data, not memories. */
export const looksLikeBusinessRecord = (text: string): boolean => {
  if (AMOUNT.test(text) || DOCUMENT_NUMBER.test(text) || TAX_NUMBER.test(text)) return true;
  const words = foldWords(text);
  return CUSTOMER_WORDS.some((p) => findPhrase(words, p) !== -1) && NAME_LIST.test(text);
};

// ---- sensitive categories: only on an explicit request ----

export type SensitiveCategory = "health" | "finance" | "others";

/** Word starts (stems) per category; a word matches if it begins with one. Multi-word entries match as phrases. */
const SENSITIVE_STEMS: Record<SensitiveCategory, readonly string[]> = {
  health: [
    "doctor", "medic", "hospital", "diagnos", "medication", "medicament", "medicine", "pill", "comprimido", "prescri",
    "allerg", "alerg", "therap", "terapi", "depress", "anxiety", "ansiedade", "cancer", "cancro", "surgery",
    "cirurgi", "pregnan", "gravid", "illness", "doenc", "disease", "symptom", "sintoma", "diabet", "psychiatr",
    "psiquiatr", "psycholog", "psicolog", "clinic", "health", "saude", "injur", "lesao", "sick", "doente",
    "vaccin", "vacin", "dentist", "dentista", "blood", "sangue",
  ],
  finance: [
    "salary", "salari", "ordenado", "wage", "debt", "divida", "bank", "banco", "mortgage", "hipoteca", "loan",
    "emprestimo", "credit card", "cartao de credito", "savings", "poupanc", "invest", "tax return", "income",
    "rendimento", "saldo", "pension", "pensao", "rent", "renda", "overdraft", "credito", "insurance",
  ],
  others: [
    "divorc", "separated", "separad", "affair", "arrest", "detid", "police", "policia", "crime", "criminal", "religio",
    "sexual", "lgbt", "immigra", "imigra", "visa status", "tribunal", "lawsuit", "processo judicial",
  ],
};

const matchesStems = (words: readonly string[], stems: readonly string[]): boolean =>
  stems.some((stem) => {
    const parts = phrase(stem);
    if (parts.length > 1) return findPhrase(words, parts) !== -1;
    const one = parts[0] ?? stem;
    return words.some((w) => w.startsWith(one));
  });

/** The sensitive categories a text touches, by word list. Empty when none. */
export const sensitiveCategories = (text: string): SensitiveCategory[] => {
  const words = foldWords(text);
  return (Object.keys(SENSITIVE_STEMS) as SensitiveCategory[]).filter((c) => matchesStems(words, SENSITIVE_STEMS[c]));
};

// ---- EC / HRT ----

/**
 * The EC's own names. In a Noisy Source invoicing playbook (the routing
 * precheck's invoicing exception) these may appear; every other cue in the
 * handoff contexts (HRT, UTP, CASP, Recruiter Portal UTP, Cast-p, EPSO,
 * Kiro, and any added later) never may.
 */
export const EC_NAMES_ALLOWED_IN_INVOICING = ["European Commission", "Comissão Europeia", "EC"] as const;

export type EcMatchers = {
  /** Any handoff cue (EC/HRT), or a never-remember name. */
  readonly mentionsEc: (text: string) => boolean;
  /** A cue that's never allowed, even in an invoicing playbook, or a never-remember name. */
  readonly mentionsForbidden: (text: string) => boolean;
};

/**
 * Built from the handoff contexts' cues in contexts.md plus the names in the
 * gitignored data/never-remember.txt (colleagues and the like).
 */
export const makeEcMatchers = (contexts: readonly Context[], neverRemember: readonly string[]): EcMatchers => {
  const cues = contexts.flatMap((c) => (c.handling.kind === "handoff" ? c.handling.cues : []));
  const allowed = new Set<string>(EC_NAMES_ALLOWED_IN_INVOICING.map((n) => foldWords(n).join(" ")));
  const strict = cues.filter((cue) => !allowed.has(foldWords(cue).join(" ")));
  const names = neverRemember.map((n) => n.trim()).filter((n) => n.length > 0);
  const any = [...cues, ...names].map(makeCueMatcher);
  const forbidden = [...strict, ...names].map(makeCueMatcher);
  return {
    mentionsEc: (text) => any.some((m) => m(text)),
    mentionsForbidden: (text) => forbidden.some((m) => m(text)),
  };
};

/** data/never-remember.txt: one name or phrase per line; blank lines and # comments are ignored. */
export const parseNeverRemember = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
