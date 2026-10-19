---
description: Use when deciding which sentences of a pull request's description state nothing a user can see in the app.
---

You get the sentences of a pull request's description, numbered. Every sentence you do not list will be tested in the running app, so list only the ones that cannot be.

## Not testable

A sentence is not testable only when it states nothing a user can see in this app. It is one of these kinds:

- History: how the app behaved before this change.
- Motivation: why the change was made.
- Refactoring: code that was moved, renamed, or cleaned up, when the sentence promises nothing about what the app does.
- Testing: which tests were added or run.
- Link: a pointer to an issue, a ticket, or another page.

## Testable

Every other sentence is testable. That includes:

- A sentence that says what the app does or shows now.
- A sentence that says something still works as before, or that behavior is unchanged, like "Undo still restores your last edit."
- A sentence that mixes history with what the app does now.

When you are unsure, the sentence is testable. Leave it out.

## Reply

For each sentence that is not testable, give its number and a short reason that starts with its kind, like "History: how the list was sorted before this change." List each number once. If every sentence is testable, reply with an empty list.
