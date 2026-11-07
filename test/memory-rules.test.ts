import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { parseContexts } from "../src/contexts.js";
import {
  asksNotToRemember,
  asksToForget,
  asksToRemember,
  containsSecret,
  contextNameWords,
  looksLikeBusinessRecord,
  mentionsCustomerOrDebt,
  namesSomeone,
  makeEcMatchers,
  parseNeverRemember,
  sensitiveCategories,
  type EcMatchers,
} from "../src/memory-rules.js";
import type { Context } from "../src/types.js";

let contexts: readonly Context[] = [];
let ec: EcMatchers;
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  contexts = parsed.value;
  ec = makeEcMatchers(contexts, ["Jane Example", "João Exemplo"]);
});

describe("asksToRemember (an explicit request, in the user's own words)", () => {
  it.each([
    "Remember that Inês's teacher is Ms Rita",
    "please REMEMBER this: Sam's birthday is 3 May",
    "Take note: I'm allergic to penicillin",
    "lembra-te que a Inês tem natação à terça",
    "Lembra que o Sam faz anos a 3 de maio",
    "lembre-se disto",
    "guarda isto: o médico é a Dra. Marta",
    "Guarda que prefiro respostas curtas",
    "não te esqueças que tenho consulta amanhã",
    "Nao te esquecas: o seguro do carro vence em março",
    "NÃO TE ESQUEÇAS disto",
    "Anota: a renda sobe em janeiro",
    "ANOTA aí que a Inês é alérgica a nozes",
    "don't forget my salary is paid on the 25th",
  ])("%j counts", (question) => {
    expect(asksToRemember(question)).toBe(true);
  });

  it.each([
    "Don't remember this",
    "do not remember that",
    "Do you remember Inês's teacher?",
    "can you guess what I said?",
    "a anotação da reunião",
    "o guardanapo está na mesa",
    "lembras-te do que disse?",
    "What's the capital of Australia?",
    "I'm allergic to penicillin",
  ])("%j doesn't count", (question) => {
    expect(asksToRemember(question)).toBe(false);
  });
});

describe("asksNotToRemember (keep this exchange out of memory)", () => {
  it.each([
    "Não guardes isto, mas estou a pensar mudar de emprego",
    "nao guardes isto",
    "Não guardes isso, ok?",
    "não te lembres disto: tive uma discussão com o chefe",
    "Esquece isto, foi só um desabafo",
    "ESQUECE ISTO",
    "Don't remember this, but I'm thinking of quitting",
    "do not remember this",
    "Don't keep this: I'm interviewing elsewhere",
    "don't save this please",
    "Do not save this",
    "Off the record, I'm unhappy at work",
    "this is off the record",
  ])("%j opts out", (q) => expect(asksNotToRemember(q)).toBe(true));

  it.each([
    "Remember that Inês's teacher is Ms Rita",
    "guarda isto: a renda sobe em janeiro",
    "Forget that I take espresso",
    "esquece que tomo café",
    "I don't remember her name",
    "não me lembro do nome dela",
    "What's the record for the marathon?",
    "hello",
  ])("%j doesn't", (q) => expect(asksNotToRemember(q)).toBe(false));
});

describe("asksToForget", () => {
  it.each(["Forget that", "esquece isso", "Esqueça o que disse", "apaga isso", "please delete that memory", "remove the coffee one"])(
    "%j asks to forget",
    (q) => expect(asksToForget(q)).toBe(true),
  );
  it.each(["don't forget my salary", "never forget this", "não te esqueças", "hello"])("%j doesn't", (q) =>
    expect(asksToForget(q)).toBe(false),
  );

  it("only opens the door: 'what did I forget?' passes the word check, and the model must still pick a memory", () => {
    expect(asksToForget("what did I forget?")).toBe(true);
  });
});

describe("containsSecret (never kept, even on request)", () => {
  it.each([
    "My Anthropic key is sk-ant-api03-abcdefghijklmnop",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123",
    "AWS key AKIAABCDEFGHIJKLMNOP",
    "The wifi password is hunter2",
    "o PIN do cartão é 1234",
    "a palavra-passe do banco é X",
    "a senha do email é abc",
    "card 4111 1111 1111 1111",
    "IBAN PT50 0002 0123 1234 5678 9015 4",
    "abcdEFGH1234ijklMNOP5678qrstUVWX9012",
    "-----BEGIN RSA PRIVATE KEY-----",
  ])("%j is a secret", (text) => expect(containsSecret(text)).toBe(true));

  it.each([
    "Inês's teacher is Ms Rita",
    "Gym on Monday, Wednesday and Friday at 07:30",
    "Phone 912 345 678", // 9 digits: not a card (too short), not a key
    "Pinto is the plumber's surname",
  ])("%j isn't", (text) => expect(containsSecret(text)).toBe(false));
});

describe("looksLikeBusinessRecord (never kept from a business context)", () => {
  it.each([
    "Invoice FT 2026/123 is unpaid",
    "Fatura nº 2026045 por pagar",
    "The Silva family owes €120",
    "Total was 1.250,00 euros",
    "NIF 123456789",
    "PT 501234567 is the client's tax number",
    "Clients: Ana Silva, Rui Costa, Marta Dias",
    "Order #4521 shipped",
  ])("%j is a record", (text) => expect(looksLikeBusinessRecord(text)).toBe(true));

  it.each([
    "List unpaid invoices oldest first",
    "KidClub opens at 08:00",
    "Invoice the EC on the first working day of the month",
    "Monthly fees are due by the 8th",
  ])("%j isn't", (text) => expect(looksLikeBusinessRecord(text)).toBe(false));
});

describe("people in business contexts", () => {
  it.each([
    "Asked about the Silva family's unpaid balance",
    "Asked whether Ana Costa paid",
    "Perguntou se a família Silva já pagou",
    "Checked on Rui's fees",
  ])("%j names someone", (text) => expect(namesSomeone(text, contextNameWords(contexts))).toBe(true));

  it.each([
    "Asked about an unpaid KidClub invoice",
    "Perguntou por uma fatura da KidClub por pagar",
    "Asked how Noisy Source invoices the EC",
    "Asked about invoices due on Monday in March",
    "Silva: nothing else", // the first word of a sentence isn't counted
    "Invoice the European Commission on the first working day",
  ])("%j doesn't", (text) => expect(namesSomeone(text, contextNameWords(contexts))).toBe(false));

  it.each(["Asked which families haven't paid", "A family owes two months", "Perguntou pelas dívidas", "Asked about a customer's debt", "o cliente da sala 2"])(
    "%j mentions a customer, family or debt",
    (text) => expect(mentionsCustomerOrDebt(text)).toBe(true),
  );

  it.each(["Asked about an unpaid KidClub invoice", "Asked which invoices are overdue", "Perguntou pelas faturas em atraso"])(
    "%j doesn't",
    (text) => expect(mentionsCustomerOrDebt(text)).toBe(false),
  );
});

describe("sensitiveCategories (only on an explicit request)", () => {
  it.each([
    ["Allergic to penicillin", ["health"]],
    ["Tem consulta no médico às terças", ["health"]],
    ["A Inês está a tomar medicação para a asma", ["health"]],
    ["Salary is paid on the 25th", ["finance"]],
    ["A hipoteca sobe em janeiro", ["finance"]],
    ["Owes the bank 2000", ["finance"]],
    ["Sam's sister is getting divorced", ["others"]],
    ["O irmão foi detido pela polícia", ["others"]],
    ["Inês's teacher is Ms Rita", []],
    ["Prefers answers in Portuguese", []],
    ["Tenho a certeza, é seguro", []],
    ["Vou consultar a agenda", []],
  ])("%j → %j", (text, expected) => expect(sensitiveCategories(text)).toEqual(expected));
});

describe("EC matchers", () => {
  it("knows every EC/HRT cue and the never-remember names", () => {
    for (const t of ["the European Commission", "a Comissão Europeia", "EC invoices", "HRT", "the UTP standup", "CASP", "Cast-p", "Recruiter Portal UTP", "EPSO", "Kiro", "Jane Example", "joao exemplo"]) {
      expect(ec.mentionsEc(t)).toBe(true);
    }
    expect(ec.mentionsEc("Inês's teacher")).toBe(false);
    expect(ec.mentionsEc("the ec")).toBe(false); // "EC" is an acronym: case-sensitive, like the precheck
  });

  it("allows only the EC's own names in invoicing playbooks", () => {
    for (const t of ["Invoice the EC on the 1st", "Fatura à Comissão Europeia no dia 1", "European Commission invoices go to the portal"]) {
      expect(ec.mentionsForbidden(t)).toBe(false);
    }
    for (const t of ["Invoice the EC for the UTP work", "HRT hours", "CASP", "Cast-p", "Recruiter Portal UTP", "EPSO", "Kiro", "Send it to Jane Example"]) {
      expect(ec.mentionsForbidden(t)).toBe(true);
    }
  });

  it("parses the never-remember file", () => {
    expect(parseNeverRemember("# colleagues\nJane Example\n\n  João Exemplo  # team lead\n")).toEqual(["Jane Example", "João Exemplo"]);
  });
});
