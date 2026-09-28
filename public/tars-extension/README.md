# TARS Vision Bridge 1.2.73

- Added persistent Automation Safety ON/OFF switch in popup. OFF blocks automatic Hyperflow/Hoymiles automation; manual popup tools remain available.
- Added background safety gate for Hoymiles account creation.
- Region selection: when only the state is supplied, prefer an exact same-name child region if available; otherwise accept the first enabled child region.
- Updated internal Hyperflow version markers to 1.2.73.


## v1.2.81 — TARS Observer Mode

Observer Mode is a passive learning/recording layer. It is enabled by default for new/upgraded installs and disables customer-facing automation while active. The Bridge records newly captured Hyperflow messages, high-level technician UI actions on Hyperflow/Hoymiles (without keystrokes or input values), and page navigation, then queues events locally and sends batches to Solar Agenda at:

`https://solar-agenda.vercel.app/api/tars/observer/events`

The backend treats these events as an event stream for TARS Cases / Closed Cases / learning candidates. The Bridge never sends customer replies or closes conversations while Observer Mode is enabled.


## Workflow Learning (1.2.83)
- Optional popup switch: Workflow Learning. Default OFF.
- When enabled, the bridge observes HTTP/HTTPS sites visited after leaving Hyperflow.
- It records navigation, semantic UI actions, and sanitized DOM structure (headings, buttons, links, navigation, tabs, form structure and non-secret field metadata).
- It never records keystrokes or field values and never performs customer-facing actions.
- Hyperflow protocol context is used as a case hint; unrelated site visits remain unbound until the backend correlates them.
- Requires broad host access because Chrome otherwise cannot inject a passive observer into arbitrary sites.
- Backend endpoint at `/api/tars/observer/events` ingests event streams and registers them to the active TARS Case.
