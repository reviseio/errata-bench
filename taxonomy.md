## Hierarchical benchmark taxonomy

- 1. Orthography and word form
  - 1.1 Typographical errors
    - fat-finger typo: an accidental keyboard mistake, such as striking the wrong key.
    - omission: leaving out a letter, character, or short word.
    - insertion: adding an extra letter, character, or short word.
    - transposition: swapping the order of letters or words, such as *form* for *from*.
    - duplication: unintentionally repeating a letter or word.
  - 1.2 Spelling and casing
    - nonword spelling error: a misspelling that creates a nonword.
    - real-word spelling error: a misspelling that produces a different valid word.
    - capitalization error: incorrect uppercase or lowercase usage.
    - spacing error: missing, extra, or misplaced spaces.
    - hyphenation or compounding error: incorrect joining, splitting, or hyphenating of words.
  - 1.3 Morphology and inflection
    - incorrect pluralization: an incorrect singular or plural noun form.
    - incorrect conjugation: an incorrect verb inflection.
    - wrong word form: the wrong derivational form, such as noun vs. adjective vs. adverb.
- 2. Lexical choice and confusability
  - 2.1 Word selection
    - misused word: the wrong lexical item is chosen for the context.
    - homophone confusion: a same-sounding word is chosen incorrectly, such as *their* for *there*.
    - homograph or near-neighbor confusion: a visually or semantically similar word is chosen incorrectly.
    - malapropism: the wrong word is used because it sounds similar to the intended one.
    - collocation error: words are individually plausible but form an unnatural combination.
  - 2.2 Mishearing and reinterpretation
    - mondegreen: a phrase is misheard and then repeated or written incorrectly.
    - eggcorn: a misheard form is reanalyzed into a plausible-seeming alternative.
  - 2.3 Idiomaticity
    - idiom error: an idiomatic expression is altered, misremembered, or completed incorrectly.
- 3. Grammar and syntax
  - 3.1 Agreement
    - subject-verb agreement: the verb does not match the subject in number or person.
    - pronoun agreement: the pronoun does not match its antecedent under the annotation policy.
  - 3.2 Verb system
    - incorrect tense: the tense does not fit the sentence or discourse context.
    - auxiliary or modal error: the helping verb or modal is missing, extra, or incorrect.
  - 3.3 Clause and sentence structure
    - sentence fragment: an incomplete independent clause.
    - run-on, fused sentence, or comma splice: independent clauses are joined incorrectly.
    - word order error: constituents appear in an incorrect or unnatural order.
    - missing word: a required function word or content word is omitted.
    - extra word: an unnecessary word is inserted.
    - parallelism error: coordinated or listed elements are not grammatically parallel.
    - relative-clause error: the relative marker or clause attachment is malformed.
    - coordination or subordination error: linking structure between clauses is incorrect.
  - 3.4 Function words and reference
    - article or determiner error: an article, determiner, or quantifier is incorrect or missing.
    - preposition error: the wrong preposition is used, or a needed one is omitted.
    - pronoun-case error: the pronoun has the wrong case form.
    - pronoun-reference error: the referring expression points to the wrong entity or is harmfully ambiguous.
    - dangling or misplaced modifier: a modifier attaches to the wrong target or lacks a clear target.
  - 3.5 Polarity and comparison
    - double negative: negation is marked in a non-target way for the benchmark.
    - negation-scope error: the wording places negation over the wrong part of the sentence.
    - comparative or superlative error: comparison marking is incorrect.
    - countability error: a noun is treated incorrectly as count or mass.
- 4. Punctuation and boundaries
  - punctuation error: punctuation is incorrect, missing, or extraneous.
  - apostrophe error: possessive or contraction marking is wrong.
  - quotation or delimiter error: quotation marks, parentheses, brackets, or similar delimiters are used incorrectly.
  - sentence-boundary error: punctuation causes an incorrect split or merge between sentences.
- 5. Semantics, discourse, and style
  - 5.1 Semantics
    - semantic anomaly: the wording is grammatical but semantically incompatible or contradictory.
    - referential ambiguity: a referring expression permits multiple harmful interpretations.
  - 5.2 Discourse
    - discourse coherence error: connective or logical structure is missing, inconsistent, or inappropriate.
    - cross-sentence tense inconsistency: tense use is locally grammatical but globally inconsistent.
  - 5.3 Style and register
    - wordiness or redundancy: the text is unnecessarily repetitive or verbose.
    - register mismatch: phrasing is inappropriately formal, informal, or otherwise mismatched to context.
    - awkward phrasing: the sentence is grammatical but unnatural or hard to process.
    - nonstandard dialect or colloquial form: a regionally or socially marked form appears where the benchmark expects a standardized target variety.

Benchmark design note: this taxonomy is broad enough for a strong benchmark, but it will never be absolutely complete. The practical goal is to minimize overlap, define clear annotation rules, and decide whether child labels are mutually exclusive, multi-label, or hierarchical-only.

Recommended metadata fields: parent label, child label, severity, edit scope (character, token, phrase, clause, sentence, discourse), operation type (substitution, omission, insertion, transposition, duplication, agreement mismatch, boundary error), whether the corruption creates another valid word, and whether the example is primarily orthographic, grammatical, semantic, or stylistic.

High-value benchmark distinction: keep separate labels for nonword vs. real-word spelling errors, lexical confusions vs. true grammatical errors, local sentence errors vs. discourse-level errors, and true errors vs. awkward but still acceptable variants.

Labeling recommendation: use stable machine-friendly label names in the dataset, such as *orthography.nonword_spelling* or *lexical_choice.homophone_confusion*, and keep the human-readable definitions separate. This makes aggregation, versioning, and benchmark reporting much easier.

Recommended annotation structure: use broad parent labels for reporting and narrower child labels for dataset annotation. A practical schema is *parent > child*, for example *grammar_and_syntax > subject_verb_agreement*. This supports both fine-grained evaluation and rolled-up scoring.
