# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Workflow state

Triage labels answer _who should pick this up_. These answer _where in the pipeline it is_ — so a glance at the issue list tells you what's actually in flight.

| Label         | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| `in-progress` | Claimed and actively being worked. The assignee is the claim. |
| `blocked`     | Work started but can't continue. The body says on what.       |
| `in-review`   | Implementation done, PR open, awaiting review.                |

Rules:

- At most one state label at a time. Moving state means removing the old one in the same `gh issue edit` (`--add-label in-review --remove-label in-progress`).
- State labels are orthogonal to triage labels — an issue keeps its `ready-for-agent`/`ready-for-human` role while it moves through the states.
- No state label means "not started". Closing an issue clears the state label.
- Take `in-progress` at the same moment you take the assignee, not before — an unassigned `in-progress` issue is a lie about who's on it.
