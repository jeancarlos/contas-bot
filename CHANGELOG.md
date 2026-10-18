# Changelog

What changed in each release of contas-bot, newest first. Generated from the release commit trailers by `npm run changelog`.

## 2.0.5

No user-visible changes in this release: internal, dependency and security maintenance.

## 2.0.4

No user-visible changes in this release: internal, dependency and security maintenance.

## 2.0.3

- skip the attestation check when gh is too old to have it

## 2.0.2

No user-visible changes in this release: internal, dependency and security maintenance.

## 2.0.1

No user-visible changes in this release: internal, dependency and security maintenance.

## 2.0.0

- manage bills with /conta and apply edited commands
- ask which bill on an ambiguous /pago and offer a one-off for an unknown one
- ask the sender back when a receipt or a /pago is missing something
- /pago avulsa pays a one-off expense on that month's list only

## 1.3.0

- accept /paguei and /pagar as /pago
- handle commands sent while the bot was offline
- /pago reads any currency and an amount before the bill
- bot answers only slash commands, receipts read only for amount

## 1.2.0

- bot announces each new version in the group with a GIF
- announcement text with the changes in the group's language

## 1.1.2

- exit when a reconnect cannot start so the container restarts
- resolve WA version per start, keep exit status in the restore trap, harden smoke boot
- v1.1.2 review findings

## 1.1.1

- announce the current WhatsApp Web version, QR as an image, group jids

## 1.1.0

- installer key reuse is per provider; review keeps PUID/PGID
- installer shows and reuses the current configuration

## 1.0.0

- put the restart hint on the loggedOut-unpaired log line
- installer review findings (SIGINT, re-pair stop, prerelease, auth 0700, main wrapper, llm auth header)
- quote uninstall hint path and forward digit env names
- one-command bootstrap installer, versioned image and CI smoke test
- swap redirection order to prevent tty open error leak, add nonexistent tty path test
- use CONTAS_BOT_TTY env to redirect /dev/tty reads in tests to /dev/null
- validate versions, safe installer download, tty hint, pair resilience, help to stdout
- contas-bot CLI with online update, status, logs, pair and restart
- pairing fails on unsaved creds, restarts once, exits cleanly
- pair WhatsApp inside the installer by QR or code, retry only on request
- installer TUI that writes .env, compose and the CLI
- installer core - answers, env, compose and mode detection
- an unpaired bot without BOT_PHONE waits for the installer instead of asking for a code
- run without an AI endpoint; drop the unused caption model
- stop re-posting the list on failed onboarding saves, keep numeric bills payable, tighten plain-text suggestions
- keep numeric bill names payable and only answer plain text with a suggestion
- explain missing bill names and suggest mistyped commands
- answer mistyped bills with a suggestion, including short payment phrases
- single command table and command-name suggestions
- find the bills closest to a mistyped name
- scrub git env in hook tests, close retarget bypass, harden hook install
- roll back failed saves, expire pending receipt amounts, retry failed onboarding on tick
- idle after an unused pairing code instead of requesting another
- close the review batch 4 findings
- revoke a group's authorization when the bot is removed from it
- remember the jid an invite link resolved to
- make GROUP_INVITE_LINKS truly optional and stop an ungated fetch
- accept a group invite link in GROUP_INVITE_LINKS
- key the pending receipt amount on the sender's jid
- persist the dedup list and bind a pending receipt amount to its sender
- dedup redelivered messages by id, not text
- warn the group when persisting a payment or reversal fails
- drop a corrupt month value instead of operating on it
- only strip the bot's own divider from rescued group text
- remember a receipt's amount while asking which bill it is for
- group discovery failure no longer blocks onOpen
- backfill listed from pinned when loading older state
- gate the join republish on a posted list, not a successful pin
- normalize the legacy GROUP_JID migration key like served group jids
- description/list bugs - save order, stale pins, emptied sections, lost notes
- receipts no longer hijack other commands or trust low-confidence amounts
- money bugs - amount overwrite, malformed/sub-cent/foreign parsing, prototype pollution
- gate before parsing, seal the callback bypass, reject non-group jids
- serve only the groups listed in GROUP_JIDS
- add a group allowlist parser and callback gate
- end the bill list at the help line when the divider was deleted
- stop the below-section rescue at a second bot header
- mark an empty group description with a placeholder and keep text typed below the section
- accept only the catalogs' own keys as BOT_LANG
- reject amounts of 1e12 or more from commands and receipts
- match a plain-text bill on the whole message before stripping payment words
- a bill named like the whole /pago argument wins over name plus amount
- swallow a bare currency code only when it is the configured currency
- reject repeated separators that are not three-digit thousands groups
- strip only currency tokens from amounts so bill names keep their digits
- speak the configured language and currency everywhere
- keep multi-word bill names, harden TZ and reject bad-sign amounts
- render in the configured locale and parse commands and amounts in any language
- add pt-BR, en and es message catalogs and the locale config
- read the receipt when a /pago caption names no bill
- refuse receipts over 16 MB before downloading them
- answer a receipt captioned /pago with an unknown bill instead of asking the LLM
- pin the new list before unpinning the previous one
- never cut the group's text or the bill list to fit the description limit
- reconcile description events against a fresh read, including a cleared description
- match owners across the Brazilian ninth digit and onboard when any owner resolves
- seed bills from saved state so a restart does not repost or miss offline messages
- serve every group the bot is in, onboarding on join
- onboard new groups, own a section of the description, answer /help and greetings
- keep state per group and migrate the single-group file
- render and parse the bot's own section of the group description
- time out pdftoppm so one bad PDF cannot stall every handler
- match 'pago agua' and 'paguei aluguel' as payments
- a divider line ends the bill list so the group description can carry help text
- skip 'Contas:' headings and accept '- pausado' in the group description
- throttle pairing codes by time, verify the auth wipe, always back off before exiting
- request the pairing code on the qr event and empty the auth mount instead of removing it
- serialize handlers, republish on description change, harden async paths
- request the pairing code only once per process
- back off a minute before restarting after a failed pairing
- wipe auth on logged-out so the restart pairs cleanly
- allow first boot without GROUP_JID for pairing
- baileys adapter, pdf rendering and entrypoint
- message handler with commands, receipts, pinning and monthly reset
- 9router client for captions and receipts
- atomic json state store
- bill list parsing, matching and rendering
