# Activity Logger

A single-page web app that asks "What are you doing right now?" at a fixed
interval (default: every 10 minutes) during the time frames you choose, waits
for your answer, and logs it with timestamps.

## Use it

1. Open `index.html` in a desktop browser (or host it, e.g. with GitHub Pages).
2. Click **Enable notifications**.
3. Set the interval and your time frames (start, end, days of the week).
4. Leave the tab open. At each prompt you get a notification; type your answer
   and press **Log it** (or Ctrl/⌘ + Enter).

## How it behaves

- Prompts land on the interval from each time frame's start (09:00, 09:10, …).
- A prompt stays open until you answer. If the next prompt arrives first, the
  unanswered one is logged as **Missed**.
- Each entry records when you were asked and when you answered.
- **Export CSV** downloads the full log; **Ask me now** triggers a prompt.

## Limits

- It only runs while the tab is open. Mobile browsers pause background tabs, so
  use it on a desktop or laptop.
- Data is stored in this browser's local storage, so export the CSV to keep it.
