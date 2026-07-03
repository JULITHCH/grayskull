/** Busy-spinner quips — what GRAYSKULL mutters instead of "thinking…".
 *  One is picked at random per turn. Edit freely: add, delete, reword.
 *  Keep them short (one spinner line) and lowercase-ish; the ellipsis is
 *  appended by the UI. */

export const QUIPS: string[] = [
  "I HAVE THE POWERRR",
  "channeling the power of Grayskull",
  "by the honor of Grayskull",
  "consulting the Sorceress",
  "sharpening the Power Sword",
  "raising the jawbridge",
  "Battle Cat is warming up",
  "Cringer would rather not — doing it anyway",
  "Skeletor is NOT going to like this",
  "Skeletor screams in the distance",
  "NYAAH! wrong lever",
  "plotting louder than Skeletor",
  "peering into Snake Mountain",
  "Evil-Lyn hexed the tokens, re-rolling",
  "Beast Man is fetching the context window",
  "Trap Jaw is chewing on the bytes",
  "Orko dropped the spellbook again",
  "Man-At-Arms is soldering something",
  "Teela says this plan is terrible. proceeding",
  "asking Zodac (he won't interfere)",
  "summoning thunder over Eternia",
  "opening the Mystic Wall",
  "flexing at the terminal",
  "fury of Eternia, patience of a cron job",
  "polishing the harness",
  "riding Battle Cat through the token stream",
  "Mer-Man gurgled something unhelpful",
  "Ram Man is headbutting the problem",
  "Stratos is circling the solution",
  "loins girded, sword drawn, GPU hot",
  // classic memes, lovingly abused
  "fabulous secret powers are being revealed",
  "UNTIL WE MEET AGAINNN — kidding, still here",
  "until next time… no wait, this time",
  "retreating dramatically (strategically) like Skeletor",
  "you FOOL! (the bug, not you)",
  "curse you He-Man, and curse this regex",
  "muscle-bound oaf crunching tokens",
  "I'll be back — wrong franchise, still true",
  "letting the good guys win… eventually",
  "cackling, vanishing in a puff of smoke, computing",
];

export function randomQuip(): string {
  return QUIPS[Math.floor(Math.random() * QUIPS.length)] ?? "working";
}
