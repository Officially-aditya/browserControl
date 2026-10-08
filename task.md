# Tasks & Issues to Optimize

I think we need to optimise for these as well:

### 1. What Happened During Each Queue Execution

#### STALE_OBSERVATION Expiration:
Coordinate-based action queues require an `observationId` from a prior snapshot (e.g. `browser_snapshot`).
If any background event, auto-routing transition, or DOM evaluation occurred between the snapshot and the queue dispatch, the extension invalidated the observation token immediately:
```json
{"success":false, "errorCode":"STALE_OBSERVATION", "message":"observation expired or not found"}
```

#### Extension RPC Timeout (DEVICE_TIMEOUT):
When sending multi-step sequential actions (e.g., clicking 4 checkboxes across multiple positions, dwell delays, and a mouse-wheel scroll):
```json
{"success":false, "errorCode":"DEVICE_TIMEOUT", "message":"Extension RPC timed out: action_queue"}
```
The extension’s internal RPC bridge times out if the total dwell delays and input simulation take longer than its fixed execution window.

#### Router Page Shifts Causing QUEUE_ACTION_FAILED:
When attempting DOM selector targeting (`#next_button_demo` or `#education10`) without coordinates:
```json
{"success":false, "errorCode":"QUEUE_ACTION_FAILED", "message":"Element not found or not visible: #education10"}
```
The underlying survey router (Samplicio / IRBureau) had already initiated an HTTP/JS redirect in the background right as the action was queued, unmounting the target elements before the queue could dispatch the clicks.

#### SurveyJS Shadow Dropdown Behavior:
On the Samplicio question pages, the dropdown elements use readonly text inputs and SurveyJS virtualized popups that render into an isolated container. Sending standard native mouse clicks to the input box didn't open the option list (it rendered "No data to display" without a touch/pointer gesture payload), which prevented coordinate clicks from selecting the item.
