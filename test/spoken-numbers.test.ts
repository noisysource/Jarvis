import { describe, expect, it } from "vitest";
import { integerWords, ordinalWords, speakableNumbers, yearWords } from "../src/web/spoken-numbers.js";

describe("numbers in words for the voice (#92)", () => {
  it("reads whole numbers", () => {
    expect(integerWords(0)).toBe("zero");
    expect(integerWords(13)).toBe("thirteen");
    expect(integerWords(40)).toBe("forty");
    expect(integerWords(366)).toBe("three hundred sixty-six");
    expect(integerWords(1_000_005)).toBe("one million five");
    expect(integerWords(12_345)).toBe("twelve thousand three hundred forty-five");
  });

  it("reads years and ordinals the way they're said", () => {
    expect(yearWords(1984)).toBe("nineteen eighty-four");
    expect(yearWords(2026)).toBe("twenty twenty-six");
    expect(yearWords(2005)).toBe("two thousand five");
    expect(yearWords(1900)).toBe("nineteen hundred");
    expect(yearWords(1905)).toBe("nineteen oh five");
    expect(ordinalWords(1)).toBe("first");
    expect(ordinalWords(12)).toBe("twelfth");
    expect(ordinalWords(21)).toBe("twenty-first");
    expect(ordinalWords(40)).toBe("fortieth");
    expect(ordinalWords(103)).toBe("one hundred third");
  });

  it("rewrites a sentence for the voice", () => {
    expect(speakableNumbers("There are 366 days in a leap year.")).toBe("There are three hundred sixty-six days in a leap year.");
    expect(speakableNumbers("I am free at 9:30 am, 6 pm, 18:05 or 7:00.")).toBe("I am free at nine thirty a m, six p m, eighteen oh five or seven o'clock.");
    expect(speakableNumbers("Since 1984, and in 2026.")).toBe("Since nineteen eighty-four, and in twenty twenty-six.");
    expect(speakableNumbers("€5, $3.50 or £1,200.")).toBe("five euros, three dollars fifty or one thousand two hundred pounds.");
    expect(speakableNumbers("About 2.5% of 1,000,000 people.")).toBe("About two point five percent of one million people.");
    expect(speakableNumbers("On the 21st it was -3 degrees.")).toBe("On the twenty-first it was minus three degrees.");
    expect(speakableNumbers("Pi is 3.14.")).toBe("Pi is three point one four.");
  });

  it("leaves words, codes and other languages alone", () => {
    expect(speakableNumbers("Good question. I am here.")).toBe("Good question. I am here.");
    expect(speakableNumbers("an mp3 file")).toBe("an mp3 file");
    expect(speakableNumbers("Tenho 366 dias.", "pt")).toBe("Tenho 366 dias.");
  });
});
