/* oxlint-disable react/static-components */

import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { useEffect, useState, useRef, useLayoutEffect, useMemo, Fragment } from "react";
import {
  Achievement,
  AchievementSet,
  CodeNoteSet,
  RichPresence,
  CodeNote,
  AssetState,
  Leaderboard,
} from "./achievements";
import {
  assess_code_notes,
  assess_achievement,
  assess_leaderboard,
  assess_rich_presence,
  assess_set,
  SEVERITY_TO_CLASS,
  Feedback,
  FeedbackSeverity,
  toDisplayHex,
} from "./feedback";
import { Logic, ReqFlag, ConditionFormatter, ReqType, MemSize } from "./logic";
import { LogicExplainer } from "./explainer";
import { Auditor } from "./auditor";
import { current, get_game_title } from "./state";
import { clearSession, loadReviews, loadSession, saveReviews, saveSession } from "./storage";
import { buildUserFile } from "./userfile";
import { buildSetReport } from "./report";

const sidebar = createRoot(document.getElementById("list-body"));
const container = createRoot(document.getElementById("info-container"));
const filePicker = document.getElementById("file-picker");

// You can point to your own local middleware with ?middleware=http://localhost:3000.
const MIDDLEWARE_URL = (
  new URLSearchParams(location.search).get("middleware") ?? "https://autocr-tools.vercel.app"
).replace(/\/+$/, "");

function clearSelected() {
  for (const e of document.querySelectorAll("#list-body .selected")) {
    e.classList.remove("selected");
  }
}

function scrollTo(elem) {
  elem.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function selectTab(tab) {
  const ASSETLIST = document.getElementById("asset-list");
  for (const x of ASSETLIST.getElementsByClassName("selected")) {
    x.classList.remove("selected");
  }
  tab.classList.add("selected");

  scrollTo(tab);
  document.getElementById("asset-info").scrollTop = 0;
}

function reset_loaded() {
  current.set = new AchievementSet();
  current.notes = new CodeNoteSet();
  current.rp = null;
  current.files = []; // raw files loaded from disk, kept so the session survives a reload
  current.reviews = {};
  current.reviewsFor = null;
  current.reviewsVersion = 0; // bumped when reviews load, so open review boxes pick them up
  clearSelected();
}

document.getElementById("unload-set").addEventListener("click", async () => {
  await clearSession();
  history.pushState(null, "", location.pathname + location.search);
  location.reload();
});

// "Load by Game ID" always asks the middleware, even if files for that game were saved
let skip_saved_session = false;
const submit_gameid = () => {
  skip_saved_session = true;
  location.hash = "#!/game/" + document.getElementById("game-id").value;
};
document.getElementById("load-game-id").addEventListener("click", submit_gameid);
document.getElementById("game-id").addEventListener("keyup", ({ key }) => {
  if (key === "Enter") {
    submit_gameid();
  }
});

filePicker.addEventListener("change", () => {
  load_files(filePicker.files);
});

function __noop(event) {
  event.stopPropagation();
  event.preventDefault();
}

document.ondragover = __noop;
document.ondragenter = __noop;

document.ondrop = function (event) {
  event.preventDefault();
  load_files(event.dataTransfer.files);
};

document.onkeydown = function (event) {
  let handled = true;
  const crow = document.querySelector(".asset-row.selected");
  switch (event.key) {
    case "Up":
    case "ArrowUp":
      for (let n = crow.previousSibling; n; n = n.previousSibling) {
        if (n.classList.contains("asset-row")) {
          n.click();
          break;
        }
      }
      break;
    case "Down":
    case "ArrowDown":
      for (let n = crow.nextSibling; n; n = n.nextSibling) {
        if (n.classList.contains("asset-row")) {
          n.click();
          break;
        }
      }
      break;
    default:
      handled = false;
  }

  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
};

function load_file_text(name, text) {
  if (name.endsWith("-Notes.json")) {
    load_code_notes(JSON.parse(text));
  } else if (name.endsWith(".json")) {
    load_achievement_set(JSON.parse(text));
  } else if (name.endsWith("-Rich.txt")) {
    load_rich_presence(text, true);
  } else if (name.endsWith("-User.txt")) {
    load_user_file(text);
  } else {
    return false;
  }
  return true;
}

function load_files(fileList) {
  for (const file of fileList) {
    const idregex = file.name.match(/^(\d+)/);
    if (!idregex) {
      continue;
    }
    const thisid = +idregex[1];
    if (thisid !== current.id) {
      current.id = thisid;
      reset_loaded();
    }

    file.text().then((text) => {
      if (thisid !== current.id || !load_file_text(file.name, text)) {
        return;
      }
      current.files = current.files.filter((f) => f.name !== file.name);
      current.files.push({ name: file.name, text });
      saveSession({ id: current.id, title: get_game_title(), files: current.files });
    });
  }
}

function restore_session(session) {
  current.id = session.id;
  reset_loaded();
  current.files = session.files;
  for (const { name, text } of session.files) {
    load_file_text(name, text);
  }
}

async function show_saved_session() {
  const session = await loadSession();
  const anchor = document.getElementById("load-by-game-id");
  if (!session?.files?.length || !anchor || document.getElementById("restore-session")) {
    return;
  }

  const box = document.createElement("div");
  box.id = "restore-session";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = `Restore last session: ${session.title ?? "Game"} (${session.id})`;
  button.title = `${session.files.map((f) => f.name).join(", ")}
Saved ${new Date(session.savedAt).toLocaleString()}`;
  button.addEventListener("click", () => {
    location.hash = `#!/game/${session.id}`;
  });
  box.append(button);
  anchor.after(box);
}

async function copy_to_clipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error(error.message);
    return false;
  }
}

function download_text(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Writes notes into [gameid]-User.txt, merged with the loaded one so local assets aren't lost
function download_user_file(notes) {
  const existing = current.files?.find((f) => f.name.endsWith("-User.txt"))?.text ?? null;
  download_text(
    `${current.id}-User.txt`,
    buildUserFile({ existing, title: get_game_title(), notes }),
  );
}

function jump_to_asset(asset) {
  document.getElementById(asset?.toRefString?.())?.click();
}

// --------------------------------------------------
// TOOLTIP SYSTEM (Portal-based)
// --------------------------------------------------

const TooltipManager = {
  // Phase 1: Grace period before closing starts (allows moving mouse to tooltip)
  HIDE_DELAY_MS: 150,
  // Phase 2: Duration of the fade-out animation (Must match CSS)
  ANIMATION_MS: 150,

  state: {
    visible: false,
    content: null,
    targetRect: null,
    isExiting: false, // Tracks if we are currently animating out
  },
  listeners: [],

  timer: null, // Timer for the HIDE_DELAY
  exitTimer: null, // Timer for the ANIMATION

  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  },

  notify() {
    this.listeners.forEach((l) => l(this.state));
  },

  show(content, targetRect) {
    // Cancel any pending hide or exit timers
    this.cancelHide();

    this.state = {
      visible: true,
      isExiting: false, // Ensure we aren't fading out
      content,
      targetRect,
    };
    this.notify();
  },

  startHide() {
    // Prevent stacking timers
    if (this.timer) {
      clearTimeout(this.timer);
    }

    // 1. Wait the Buffer Time
    this.timer = setTimeout(() => {
      // 2. Start Exiting (Trigger CSS Animation)
      this.state = { ...this.state, isExiting: true };
      this.notify();

      // 3. Wait for Animation to finish, then unmount
      this.exitTimer = setTimeout(() => {
        this.state = { ...this.state, visible: false, isExiting: false };
        this.notify();
        this.exitTimer = null;
      }, this.ANIMATION_MS);

      this.timer = null;
    }, this.HIDE_DELAY_MS);
  },

  cancelHide() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
    // If we catch it while exiting, snap back to fully visible
    if (this.state.isExiting) {
      this.state = { ...this.state, isExiting: false };
      this.notify();
    }
  },
};

function GlobalTooltip() {
  const [state, setState] = useState(TooltipManager.state);

  // Default to hidden so it measures before showing
  const [layout, setLayout] = useState({
    top: 0,
    left: 0,
    opacity: 0,
    placement: "left",
    arrowOffset: 0,
  });

  const tooltipRef = useRef(null);

  useEffect(() => {
    return TooltipManager.subscribe(setState);
  }, []);

  // Perform measurement and positioning whenever content or target changes
  useLayoutEffect(() => {
    if (!state.visible || !state.targetRect || !tooltipRef.current) {
      return;
    }

    const target = state.targetRect;
    const tooltip = tooltipRef.current.getBoundingClientRect();

    // Use Actual Dimensions from the DOM
    const actualWidth = tooltip.width;
    const actualHeight = tooltip.height;

    const GAP = 10;
    // oxlint-disable-next-line no-unused-vars
    const VIEWPORT_WIDTH = window.innerWidth;
    const VIEWPORT_HEIGHT = window.innerHeight;

    let leftPos = 0;
    let topPos = target.top;
    let placement = "left";
    let transform = "";

    // --- Horizontal Logic ---
    // Try Left first
    if (target.left - GAP - actualWidth > 0) {
      leftPos = target.left - GAP;
      placement = "left";
      transform = "translateX(-100%)";
    }
    // Fallback to Right
    else {
      leftPos = target.right + GAP;
      placement = "right";
      transform = "none";
    }

    // --- Vertical Logic ---
    const targetCenterY = target.top + target.height / 2;
    topPos = target.top;

    const bottomPadding = 20;
    if (topPos + actualHeight > VIEWPORT_HEIGHT - bottomPadding) {
      const overflow = topPos + actualHeight - (VIEWPORT_HEIGHT - bottomPadding);
      topPos -= overflow;
    }

    if (topPos < 10) {
      topPos = 10;
    }

    // --- Arrow Logic ---
    let arrowOffset = targetCenterY - topPos;
    const maxArrow = actualHeight - 12;
    const minArrow = 12;

    if (arrowOffset < minArrow) {
      arrowOffset = minArrow;
    }
    if (arrowOffset > maxArrow) {
      arrowOffset = maxArrow;
    }

    setLayout({
      top: topPos,
      left: leftPos,
      transform,
      placement,
      arrowOffset,
      opacity: 1,
    });
  }, [state.visible, state.content, state.targetRect]);

  if (!state.visible || !state.content) {
    return null;
  }

  return createPortal(
    <div
      id="global-tooltip-container"
      onMouseEnter={() => TooltipManager.cancelHide()}
      onMouseLeave={() => TooltipManager.startHide()}
      ref={tooltipRef}
      style={{
        top: layout.top,
        left: layout.left,
        transform: layout.transform,
        opacity: layout.opacity,
        pointerEvents: "auto",
      }}
    >
      <div
        className={`tooltip-arrow ${layout.placement}`}
        style={{ top: layout.arrowOffset + "px" }}
      ></div>
      <div className={`tooltip-content ${state.isExiting ? "exiting" : ""}`}>{state.content}</div>
    </div>,
    document.body,
  );
}

// --------------------------------------------------
// COMPONENT UPDATES
// --------------------------------------------------

function OperandCells({
  operand,
  skipNote = false,
  chainInfo = [],
  showAliases = false,
  contextOperand = null,
  group = null,
  rowIndex = -1,
}) {
  function OperandValue() {
    if (operand == null) {
      return null;
    }

    // 0. RECALL TYPE
    if (operand.type.name === "Recall") {
      return <span className="recall-val">{operand.toString()}</span>;
    }

    // 1. MEMORY TYPE
    if (operand.type.addr) {
      let displayValue = null;
      if (showAliases && current.notes) {
        const alias = ConditionFormatter.resolveAlias(
          operand.value,
          group,
          rowIndex,
          current.notes,
          null,
        );
        if (alias) {
          // Set title to full alias so hover shows full text if truncated
          displayValue = (
            <span className="alias" title={`${alias} (0x${operand.value.toString(16)})`}>
              {alias}
            </span>
          );
        }
      }

      if (!displayValue) {
        let memaddr = operand.toValueString();
        if (chainInfo.length) {
          memaddr = (
            <Fragment>
              <span className="AddAddressIndicator">[+</span>
              {memaddr}
              <span className="AddAddressIndicator">]</span>
            </Fragment>
          );
        }
        displayValue = memaddr;
      }

      const note_text = current.notes.get_text(operand.value, chainInfo);

      if (!skipNote && note_text) {
        return (
          <span
            className="tooltip"
            onMouseEnter={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              TooltipManager.show(<pre>{note_text}</pre>, rect);
            }}
            onMouseLeave={() => TooltipManager.startHide()}
          >
            {displayValue}
          </span>
        );
      } else {
        return displayValue;
      }
    }

    // 2. VALUE / FLOAT TYPE
    else {
      // Only try enum lookup if value exists
      if (
        showAliases &&
        contextOperand &&
        contextOperand.type.addr &&
        current.notes &&
        operand.value !== undefined &&
        operand.value !== null
      ) {
        const enumLabel = ConditionFormatter.resolveEnum(
          operand.value,
          contextOperand.value,
          contextOperand.size,
          current.notes,
          chainInfo,
        );

        if (enumLabel) {
          let rawVal = "";
          if (operand.type === ReqType.FLOAT) {
            rawVal = Number(operand.value).toFixed(1);
          } else if (typeof operand.value === "number") {
            rawVal = `0x${operand.value.toString(16)}`;
          } else {
            rawVal = operand.value;
          }

          // Apply alias class here too just in case enums get super long
          return (
            <span className="enum-label alias" title={`${operand.value} (${rawVal})`}>
              {enumLabel}
            </span>
          );
        }
      }

      // Standard Display
      if (operand.type === ReqType.FLOAT) {
        return <span className="float-val">{operand.value}</span>;
      }

      // Final fallback for integers/strings
      const valStr =
        operand.value !== undefined && operand.value !== null ? operand.value.toString() : "";
      const valHex =
        typeof operand.value === "number" ? operand.value.toString(16).padStart(8, "0") : "";

      return (
        <>
          <span className="in-dec">{valStr}</span>
          {valHex && <span className="in-hex">0x{valHex}</span>}
        </>
      );
    }
  }

  return (
    <>
      <td>{operand ? operand.type.name : ""}</td>
      <td>{operand && operand.size ? operand.size.name : ""}</td>
      <td>
        <OperandValue />
      </td>
    </>
  );
}

function LogicGroup({ group, gi, logic, issues, showAliases, collapseAddAddress }) {
  let header = gi === 0 ? "Core Group" : `Alt Group ${gi}`;
  if (logic.value) {
    header = `Value Group ${gi + 1}`;
  }

  let chain_context = [];

  return (
    <>
      <tr className="group-hdr header">
        <td colSpan={10}>{header}</td>
      </tr>
      <tr className="col-hdr header">
        <td>id</td>
        <td>Flag</td>
        <td>Type</td>
        <td>Size</td>
        <td>Mem/Val</td>
        <td>Cmp/Op</td>
        <td>Type</td>
        <td>Size</td>
        <td>Mem/Val</td>
        <td>Hits</td>
      </tr>
      {[...group.entries()].map(([ri, req]) => {
        const match = [...issues.entries()].filter(([_, issue]) => issue.target === req);
        const isAddAddress = req.flag === ReqFlag.ADDADDRESS;

        const operand_chain_context_for_this_row = [...chain_context];

        // Calculate context for the NEXT row, even if this one is hidden
        if (isAddAddress) {
          // If starting a chain with an address that lacks a code note, assume Array Indexing (Index + Base).
          // Do not add the Index to the chain context, so the Base (next line) resolves as a direct address.
          const isArrayIndexing =
            chain_context.length === 0 &&
            (!req.lhs.type.addr ||
              !ConditionFormatter.getEffectiveNote(current.notes, req.lhs.value));

          if (!isArrayIndexing) {
            if (chain_context.length === 0 && req.lhs.type.addr) {
              chain_context.push({ type: "base", value: req.lhs.value });
            } else if (req.lhs.type.addr) {
              chain_context.push({ type: "offset", value: req.lhs.value });
            }
            if (req.rhs && req.rhs.type.addr) {
              chain_context.push({ type: "offset", value: req.rhs.value });
            }
          }
        } else {
          chain_context = [];
        }

        // If collapsed, do not render the row at all.
        // This ensures CSS nth-child striping works correctly on visible rows.
        if (collapseAddAddress && isAddAddress) {
          return null;
        }

        const flagClass = req.flag ? "flag-" + req.flag.name.replaceAll(/\s+/g, "") : "";

        return (
          <tr
            className={`${match.some(([_, issue]) => issue.severity >= FeedbackSeverity.FAIL) ? "warn" : ""} ${flagClass}`}
            id={req.toRefString()}
            key={`g${gi}-r${ri}`}
          >
            <td>
              {ri + 1}{" "}
              {match.map(([ndx, _]) => (
                <Fragment key={ndx}>
                  {" "}
                  <sup key={ndx}>(#{ndx + 1})</sup>
                </Fragment>
              ))}
            </td>
            <td>{req.flag ? req.flag.name : ""}</td>

            {/* LHS: Pass group/rowIndex for pointer resolving */}
            <OperandCells
              chainInfo={operand_chain_context_for_this_row}
              group={group}
              operand={req.lhs}
              rowIndex={ri}
              showAliases={showAliases}
              skipNote={false}
            />

            <td>{req.op ? req.op : ""}</td>

            {/* RHS: Pass contextOperand (LHS) for Enum resolution */}
            <OperandCells
              chainInfo={operand_chain_context_for_this_row}
              contextOperand={req.lhs}
              group={group}
              operand={req.rhs}
              rowIndex={ri}
              showAliases={showAliases}
              skipNote={false}
            />

            <td data-hits={req.hits}>{req.hasHits() ? `(${req.hits})` : ""}</td>
          </tr>
        );
      })}
    </>
  );
}

function LogicTable({ logic, issues = [], isHex = null, toggleHex = null }) {
  // Preferences
  // Uncontrolled mode fallback
  const [internalIsHex, setInternalIsHex] = useState(
    () => localStorage.getItem("pref-isHex") === "true",
  );
  const [collapseAddAddress, setCollapseAddAddress] = useState(
    () => localStorage.getItem("pref-collapseAddAddress") === "true",
  );
  const [showAliases, setShowAliases] = useState(
    () => localStorage.getItem("pref-showAliases") === "true",
  );

  // Determine effective hex state
  const effectiveIsHex = isHex !== null && isHex !== undefined ? isHex : internalIsHex;

  issues = [].concat(...issues);
  const collapseID = "collapse-addaddress-" + crypto.randomUUID();
  const aliasID = "show-aliases-" + crypto.randomUUID();

  const handleToggleHex = () => {
    if (toggleHex) {
      toggleHex();
    } else {
      const newVal = !internalIsHex;
      setInternalIsHex(newVal);
      localStorage.setItem("pref-isHex", newVal);
    }
  };

  const toggleCollapse = (e) => {
    const newVal = e.currentTarget.checked;
    setCollapseAddAddress(newVal);
    localStorage.setItem("pref-collapseAddAddress", newVal);
  };

  const toggleAliases = (e) => {
    const newVal = e.currentTarget.checked;
    setShowAliases(newVal);
    localStorage.setItem("pref-showAliases", newVal);
  };

  return (
    <div className="logic-table">
      <table
        className={`${effectiveIsHex ? "show-hex" : ""} ${collapseAddAddress ? "collapse-addaddress" : ""}`}
      >
        <tbody>
          {[...logic.groups.entries()].map(([gi, g]) => {
            // Pass collapseAddAddress down to the group
            return (
              <LogicGroup
                collapseAddAddress={collapseAddAddress}
                gi={gi}
                group={g}
                issues={issues}
                key={gi}
                logic={logic}
                showAliases={showAliases}
              />
            );
          })}
        </tbody>
      </table>
      <div className="logic-panel">
        <div style={{ display: "inline-block", marginRight: "10px" }}>
          <input
            checked={collapseAddAddress}
            id={collapseID}
            onChange={toggleCollapse}
            type="checkbox"
          ></input>
          <label htmlFor={collapseID}>Collapse AddAddress</label>
        </div>
        <div style={{ display: "inline-block", marginRight: "10px" }}>
          <input
            checked={showAliases}
            id={aliasID}
            onChange={toggleAliases}
            type="checkbox"
          ></input>
          <label htmlFor={aliasID}>Show Aliases</label>
        </div>
        <button onClick={handleToggleHex} type="button">
          Toggle Hex Values
        </button>
        <button onClick={() => copy_to_clipboard(logic.toMarkdown())} type="button">
          Copy Markdown
        </button>
      </div>
    </div>
  );
}

function ConsoleIcon({ console = null }) {
  if (console == null && current.set) {
    console = current.set.console;
  }
  if (console == null) {
    return null;
  }

  return (
    <a href={`https://retroachievements.org/system/${console.id}/games`}>
      <img
        src={`https://static.retroachievements.org/assets/images/system/${console.icon}.png`}
        title={console.name}
      />
    </a>
  );
}

function KeywordList({ list, sorted = true }) {
  list = [...list];
  if (list.length === 0) {
    return <>None</>;
  }
  if (sorted) {
    list.sort();
  }
  return (
    <>
      {list.map((x, i) => (
        <Fragment key={x}>
          {i === 0 ? "" : ", "} <code>{x}</code>
        </Fragment>
      ))}
    </>
  );
}

function LogicStats({ logic, stats = {} }) {
  function LogicOnlyStats() {
    if (logic && logic.value) {
      return null;
    }
    return (
      <>
        <li>Requirements with hitcounts: {stats.hit_targets}</li>
        <ul>
          <li>
            <span title="a checkpoint hit is a hitcount of 1, which locks when satisfied">
              Checkpoint hits
            </span>
            : {stats.hit_counts_one}
          </li>
        </ul>
        <li>Pauses and Resets</li>
        <ul>
          <li>
            <code>PauseIf</code>s: {stats.pause_ifs} ({stats.pause_locks}{" "}
            <span title="a PauseLock is a PauseIf with a hitcount">PauseLock</span>s)
          </li>
          <li>
            <code>ResetIf</code>s: {stats.reset_ifs} ({stats.reset_with_hits} with hits)
          </li>
        </ul>
      </>
    );
  }

  return (
    <ul>
      <li>Memory Length: {logic.mem.length} / 65535</li>
      <li>
        Group Count: {stats.group_count}{" "}
        {logic && logic.value ? `value groups` : `(1 Core + ${stats.alt_groups} Alts)`}
      </li>
      <li>Requirement Count: {stats.cond_count}</li>
      <ul>
        <li>Max Requirements Per Group: {stats.group_maxsize}</li>
        <li>
          <span title="A sequence of requirements linked by flags">Longest Chain</span>:{" "}
          {stats.max_chain}
        </li>
      </ul>
      <li>
        <span title="Number of unique lookups, including lookups with AddAddress">
          Memory Lookup Count
        </span>
        : {stats.memlookups.size}{" "}
        {logic && logic.value ? "" : stats.memlookups.size <= 1 ? "(possible OCA)" : ""}
      </li>
      <li>Logic Features</li>
      <ul>
        <li>
          {stats.deltas} <code>Delta</code>s, {stats.priors} <code>Prior</code>s
        </li>
        <li>
          Unique Flags: ({stats.unique_flags.size}){" "}
          <KeywordList list={[...stats.unique_flags].map((x) => x.name)} />
        </li>
        <li>
          Unique Mem Sizes: ({stats.unique_sizes.size}){" "}
          <KeywordList list={[...stats.unique_sizes].map((x) => x.name)} />
        </li>
        <li>
          Unique Comparisons: ({stats.unique_cmps.size}){" "}
          <KeywordList list={[...stats.unique_cmps]} />
        </li>
        <li>
          Source Modifications:{" "}
          {[...stats.source_modification.entries()]
            .filter(([_, c]) => c > 0)
            .map(([op, c], i) => (
              <Fragment key={op}>
                {i === 0 ? "" : ", "} <code>{op}</code> ({c})
              </Fragment>
            ))}
        </li>
      </ul>
      <LogicOnlyStats />
    </ul>
  );
}

function IssueList({ issues = [] }) {
  if (issues.length === 0) {
    return null;
  }
  return (
    <ul>
      {issues.map((issue, i) => (
        <li key={i}>
          <sup>
            (
            <a
              href="#"
              onClick={() => {
                const ctarget =
                  typeof issue.target === "string"
                    ? `asset-${issue.target}`
                    : issue.target?.toRefString();
                if (ctarget) {
                  scrollTo(document.getElementById(ctarget));
                }
              }}
            >
              #{i + 1}
            </a>
            )
          </sup>{" "}
          {issue.type.desc}
          {issue.type.ref.map((ref, i) => (
            <Fragment key={i}>
              <sup key={ref}>
                [<a href={ref}>ref</a>]
              </sup>
            </Fragment>
          ))}
          {issue.detail}
        </li>
      ))}
    </ul>
  );
}

function SubFeedback({ issues = [], label = "" }) {
  if (issues.length === 0) {
    return null;
  }
  return (
    <>
      <h2>{label}</h2>
      <IssueList issues={issues} />
    </>
  );
}

function AssetFeedback({ issues = [] }) {
  if (!issues.some((x) => x.length > 0)) {
    return null;
  }
  return (
    <div className="feedback">
      <h1>Feedback</h1>
      {issues.map((group, i) => (
        <SubFeedback issues={group} key={i} label={group.label} />
      ))}
    </div>
  );
}

function SetBadge({ href = null }) {
  return (
    <a href={href ? href : `https://retroachievements.org/game/${current.id}`}>
      <img
        className="icon float-left"
        src={
          current.set && current.set.icon
            ? current.set.icon
            : "https://media.retroachievements.org/Images/000001.png"
        }
      />
    </a>
  );
}

function AchievementBadge({ ach, className = "" }) {
  if (ach == null) {
    return null;
  }
  return (
    <img
      className={"icon " + className}
      src={ach.badge ? ach.badge : "https://media.retroachievements.org/Images/000001.png"}
    />
  );
}

function LinkedAchievementBadge({ ach, className = "" }) {
  return (
    <a href={`https://retroachievements.org/achievement/${ach.id}`}>
      <AchievementBadge ach={ach} className={className} />
    </a>
  );
}

function AssetCard({ asset, warn }) {
  let body = null;
  // oxlint-disable-next-line @nkzw/no-instanceof
  if (asset instanceof Achievement) {
    let icon = null;
    if (asset.achtype === "progression") {
      icon = <span title="progression">✅</span>;
    }
    if (asset.achtype === "win_condition") {
      icon = <span title="win_condition">🏅</span>;
    }
    if (asset.achtype === "missable") {
      icon = <span title="missable">⚠️</span>;
    }
    body = (
      <>
        <div>
          <AchievementBadge ach={asset} />
        </div>
        <div>
          <p>
            🏆 <strong>{asset.title}</strong> ({asset.points}) {icon}
          </p>
          <p>
            <em>{asset.desc}</em>
          </p>
        </div>
      </>
    );
    // oxlint-disable-next-line @nkzw/no-instanceof
  } else if (asset instanceof Leaderboard) {
    body = (
      <>
        <div>
          <p>
            📊 <strong>{asset.title}</strong>
          </p>
          <p>
            <em>{asset.desc}</em>
          </p>
        </div>
      </>
    );
  }
  return (
    <div
      className={"asset-card" + (warn ? " warning" : "")}
      onClick={() => {
        jump_to_asset(asset);
      }}
    >
      {body}
    </div>
  );
}

function CollapsibleExplainer({ title = "Logic Analysis", children }) {
  // Load state from localStorage, default to true if not set
  const [isOpen, setIsOpen] = useState(() => {
    const saved = localStorage.getItem("pref-showExplainer");
    return saved === null ? true : saved === "true";
  });

  const toggle = () => {
    const newState = !isOpen;
    setIsOpen(newState);
    localStorage.setItem("pref-showExplainer", newState);
  };

  const headerStyle = {
    padding: "10px",
    backgroundColor: "black",
    color: "white",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    userSelect: "none",
    borderRadius: isOpen ? "5px 5px 0 0" : "5px",
    fontWeight: "bold",
    transition: "border-radius 0.3s ease",
  };

  return (
    <div style={{ marginBottom: "20px" }}>
      <div onClick={toggle} style={headerStyle}>
        <span
          style={{
            marginRight: "10px",
            display: "inline-block",
            transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.3s ease",
          }}
        >
          ▶
        </span>
        {title}
      </div>
      <div className={`explainer-anim-wrapper ${isOpen ? "open" : ""}`}>
        <div className="explainer-anim-inner">
          <div
            className="explanation-container"
            style={{
              border: "1px solid #ccc",
              borderTop: "none",
              borderRadius: "0 0 5px 5px",
              margin: 0, // Override existing margin in CSS for explanation-container
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

// Review progress is keyed by asset type and id, so it survives reloads and new local edits
const review_key = (asset) => `${asset.components ? "lb" : "ach"}-${asset.id}`;
const get_review = (asset) => current.reviews?.[review_key(asset)] ?? { done: false, comment: "" };

function set_review(asset, patch, rerender = false) {
  current.reviews = { ...current.reviews, [review_key(asset)]: { ...get_review(asset), ...patch } };
  saveReviews(current.id, current.reviews);
  if (rerender) {
    sidebar.render(<SidebarTabs />);
  }
}

function load_reviews() {
  const gameid = current.id;
  if (gameid === -1 || current.reviewsFor === gameid) {
    return;
  }
  current.reviewsFor = gameid;
  loadReviews(gameid).then((reviews) => {
    if (current.id === gameid) {
      current.reviews = reviews;
      current.reviewsVersion += 1;
      sidebar.render(<SidebarTabs />);
    }
  });
}

function ReviewBox({ asset }) {
  const review = get_review(asset);
  const [done, setDone] = useState(review.done);
  const [comment, setComment] = useState(review.comment);

  return (
    <div className={`review-box ${done ? "reviewed" : ""}`}>
      <label>
        <input
          checked={done}
          onChange={(e) => {
            setDone(e.currentTarget.checked);
            set_review(asset, { done: e.currentTarget.checked }, true);
          }}
          type="checkbox"
        />{" "}
        Reviewed
      </label>
      <textarea
        onBlur={() => set_review(asset, { comment })}
        onChange={(e) => setComment(e.currentTarget.value)}
        placeholder="Review notes (saved in this browser, included in the full review)"
        rows={2}
        value={comment}
      />
    </div>
  );
}

function ReviewProgress({ assets }) {
  const reviewed = assets.filter((a) => get_review(a).done).length;
  return assets.length > 0 ? (
    <span className="review-progress">
      {" "}
      ({reviewed}/{assets.length} reviewed)
    </span>
  ) : null;
}

function formatChangeValue(value) {
  if (value === undefined || value === null || value === "") {
    return <em>(none)</em>;
  }
  return <code className="change-value">{String(value)}</code>;
}

function AssetChanges({ asset }) {
  if (!asset.published) {
    return null;
  }
  const changes = asset.changes();
  return (
    <details className="asset-changes" open={changes.length > 0}>
      <summary>
        ✏️ Local changes vs. published:{" "}
        {changes.length > 0 ? `${changes.length} field(s) changed` : "no differences"}
      </summary>
      {changes.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Published</th>
              <th>Local</th>
            </tr>
          </thead>
          <tbody>
            {changes.map(({ field, before, after }) => (
              <tr key={field}>
                <td>{field}</td>
                <td className="change-before">{formatChangeValue(before)}</td>
                <td className="change-after">{formatChangeValue(after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

function ModifiedAssetsSummary() {
  const modified = current.set.getModifiedAssets();
  if (modified.length === 0) {
    return null;
  }
  return (
    <details className="asset-changes" open>
      <summary>✏️ {modified.length} published asset(s) changed locally</summary>
      <ul>
        {modified.map((asset) => (
          <li key={asset.toRefString()}>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                jump_to_asset(asset);
              }}
            >
              {asset.title}
            </a>
            :{" "}
            {asset
              .changes()
              .map((c) => c.field)
              .join(", ")}
          </li>
        ))}
      </ul>
    </details>
  );
}

function AchievementInfo({ ach }) {
  const feedback = ach.feedback;
  const feedback_targets = new Set([].concat(...feedback.issues).map((x) => x.target));

  const [isHex, setIsHex] = useState(() => localStorage.getItem("pref-isHex") === "true");
  const toggleHex = () => {
    const newVal = !isHex;
    setIsHex(newVal);
    localStorage.setItem("pref-isHex", newVal);
  };

  return (
    <>
      <div className="main-header">
        <LinkedAchievementBadge ach={ach} className="float-left" />
        <div>
          <button
            className="float-right"
            onClick={() => copy_to_clipboard(`[${ach.title}](${window.location})`)}
            type="button"
          >
            Copy Markdown Link
          </button>
        </div>
        <h2 id="asset-title">
          🏆 <span className={`${feedback_targets.has("title") ? "warn" : ""}`}>{ach.title}</span> (
          {ach.points})
        </h2>
        <div className="float-right">
          <em>{`[${[ach.state.name, ach.achtype].filter(Boolean).join(", ")}]`}</em>
        </div>
        <p id="asset-desc">
          <span className={`${feedback_targets.has("desc") ? "warn" : ""}`}>{ach.desc}</span>
        </p>
      </div>
      <AssetChanges asset={ach} />
      <ReviewBox asset={ach} key={`${review_key(ach)}-${current.reviewsVersion}`} />

      <CollapsibleExplainer title={`Logic Analysis for: ${ach.title}`}>
        <LogicExplanation asset={ach} groups={ach.logic.groups} showDecimal={!isHex} />
      </CollapsibleExplainer>

      <CollapsibleExplainer title="Raw Logic">
        <div style={{ position: "relative", padding: "10px", backgroundColor: "#1e222a" }}>
          <button
            onClick={() => copy_to_clipboard(ach.logic.mem)}
            style={{
              position: "absolute",
              top: "20px",
              right: "20px",
              padding: "4px 10px",
              fontSize: "12px",
              zIndex: 10,
            }}
            type="button"
          >
            Copy Raw
          </button>

          <textarea
            onClick={(e) => e.target.select()}
            readOnly
            style={{
              width: "100%",
              minHeight: "60px",
              backgroundColor: "#0d1117",
              color: "#a5d6ff",
              border: "1px solid #2e3542",
              padding: "15px",
              paddingRight: "100px",
              fontFamily: "Consolas, monospace",
              fontSize: "13px",
              resize: "vertical",
              boxSizing: "border-box",
              display: "block",
              borderRadius: "4px",
            }}
            value={ach.logic.mem}
          />
        </div>
      </CollapsibleExplainer>

      <div className="data-table">
        <LogicTable
          isHex={isHex}
          issues={feedback.issues}
          logic={ach.logic}
          toggleHex={toggleHex}
        />
      </div>
      <div className="stats">
        <h1>Statistics</h1>
        <LogicStats logic={ach.logic} stats={feedback.stats} />
      </div>

      <AssetFeedback issues={feedback.issues} />
    </>
  );
}

function LeaderboardInfo({ lb }) {
  const feedback = lb.feedback;
  const feedback_targets = new Set([].concat(...feedback.issues).map((x) => x.target));

  const [isHex, setIsHex] = useState(() => localStorage.getItem("pref-isHex") === "true");
  const toggleHex = () => {
    const newVal = !isHex;
    setIsHex(newVal);
    localStorage.setItem("pref-isHex", newVal);
  };

  const COMPONENTS = ["START", "CANCEL", "SUBMIT", "VALUE"];

  // oxlint-disable-next-line unicorn/consistent-function-scoping
  function LeaderboardComponentStats() {
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    function SectionStats({ block = null }) {
      const tag = block.slice(0, 3);
      return (
        <Fragment>
          <h2>{block}</h2>
          <LogicStats logic={lb.components[tag]} stats={feedback.stats[tag]} />
        </Fragment>
      );
    }

    const [blockContents, setContents] = useState(<SectionStats block="START" />);
    return (
      <div>
        <div>
          {COMPONENTS.map((b) => (
            <button
              key={b}
              onClick={() => {
                setContents(<SectionStats block={b} />);
              }}
              type="button"
            >
              {b}
            </button>
          ))}
        </div>
        <div>{blockContents}</div>
      </div>
    );
  }

  return (
    <>
      <div className="main-header">
        <SetBadge href={`https://retroachievements.org/leaderboardinfo.php?i=${lb.id}`} />
        <div className="float-right"></div>
        <h2 id="asset-title">
          📊 <span className={`${feedback_targets.has("title") ? "warn" : ""}`}>{lb.title}</span>
        </h2>
        <div className="float-right">
          <em>{`[${[lb.state.name].filter(Boolean).join(", ")}]`}</em>
        </div>
        <p id="asset-desc">
          <span className={`${feedback_targets.has("desc") ? "warn" : ""}`}>{lb.desc}</span>
        </p>
      </div>
      <AssetChanges asset={lb} />
      <ReviewBox asset={lb} key={`${review_key(lb)}-${current.reviewsVersion}`} />

      <CollapsibleExplainer title={`Logic Analysis for: ${lb.title}`}>
        <h3>Start Conditions</h3>
        <LogicExplanation
          asset={{ title: "Start Conditions" }}
          groups={lb.components["STA"].groups}
          showDecimal={!isHex}
        />

        <h3>Cancel Conditions</h3>
        <LogicExplanation
          asset={{ title: "Cancel Conditions" }}
          groups={lb.components["CAN"].groups}
          showDecimal={!isHex}
        />

        <h3>Submit Conditions</h3>
        <LogicExplanation
          asset={{ title: "Submit Conditions" }}
          groups={lb.components["SUB"].groups}
          showDecimal={!isHex}
        />

        <h3>Value Logic</h3>
        <LogicExplanation
          asset={{ title: "Value Logic" }}
          groups={lb.components["VAL"].groups}
          showDecimal={!isHex}
        />
      </CollapsibleExplainer>

      <div className="data-table">
        {COMPONENTS.map((block) => (
          <Fragment key={block}>
            <h3>{block}</h3>
            <LogicTable
              isHex={isHex}
              issues={feedback.issues}
              logic={lb.components[block.slice(0, 3)]}
              toggleHex={toggleHex}
            />
          </Fragment>
        ))}
      </div>
      <div className="stats">
        <h1>Statistics</h1>
        <ul>
          <li>
            Format: <code>{lb.format.type}</code> ({lb.format.name})
          </li>
          <li>Lower is better? {lb.lower_is_better ? "Yes" : "No"}</li>
          <li>
            Inferred Type: <code>{lb.getType()}</code>
          </li>
        </ul>
        <LeaderboardComponentStats />
      </div>

      <AssetFeedback issues={feedback.issues} />
    </>
  );
}

function ChartCanvas({ setup }) {
  const graph = useRef();
  useEffect(() => {
    setup(graph.current);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <canvas ref={graph} />;
}

const issuesOf = (feedback) => (feedback ? [].concat(...feedback.issues) : []);
const byRank = (a, b) => a.state.rank - b.state.rank;

// Gathers every finding in the loaded set, in sidebar order, for the full review report
function collect_review_sections() {
  const toItems = (feedback) =>
    issuesOf(feedback).map((issue) => ({ severity: issue.severity, text: issue.type.desc }));

  const sections = [{ heading: "🗺️ Set", items: toItems(current.set.feedback) }];
  for (const ach of current.set.getAchievements().sort(byRank)) {
    sections.push({
      heading: `🏆 ${ach.title} (${ach.points})`,
      items: toItems(ach.feedback),
      comment: get_review(ach).comment,
    });
  }
  for (const lb of current.set.getLeaderboards().sort(byRank)) {
    sections.push({
      heading: `📊 ${lb.title}`,
      items: toItems(lb.feedback),
      comment: get_review(lb).comment,
    });
  }
  if (current.rp) {
    sections.push({ heading: "🎮 Rich Presence", items: toItems(current.rp.feedback) });
  }

  // the Auditor results are listed per message below, so skip their summary rows
  const noteItems = issuesOf(current.notes.feedback)
    .filter((issue) => !issue.type.desc.startsWith("[AUTOCR]"))
    .map((issue) => ({
      severity: issue.severity,
      text:
        issue.target?.addr === undefined
          ? issue.type.desc
          : `\`${toDisplayHex(issue.target.addr)}\`: ${issue.type.desc}`,
    }));
  for (const { addr, issues } of current.notes.audit ?? []) {
    for (const issue of issues) {
      noteItems.push({
        severity: issue.level === "ERROR" ? FeedbackSeverity.FAIL : FeedbackSeverity.WARN,
        text: `\`${toDisplayHex(addr)}\`: ${issue.message}`,
      });
    }
  }
  sections.push({ heading: "📝 Code Notes", items: noteItems });
  return sections;
}

function AchievementSetOverview() {
  const [reviewStatus, setReviewStatus] = useState(null);
  const feedback = current.set.feedback;
  // oxlint-disable-next-line no-unused-vars
  const feedback_targets = new Set([].concat(...feedback.issues).map((x) => x.target));
  const stats = feedback.stats;

  function AverageFeedback() {
    const ravg = Math.round(stats.avg_points);
    // check the extremes first, or they are shadowed by the milder ranges
    if (ravg < 4) {
      return <strong>(very low)</strong>;
    }
    if (ravg < 5) {
      return <strong>(low)</strong>;
    }
    if (ravg > 15) {
      return <strong>(very high)</strong>;
    }
    if (ravg > 10) {
      return <strong>(high)</strong>;
    }
    return null;
  }

  // oxlint-disable-next-line unicorn/consistent-function-scoping
  function CodeNotesInfo() {
    if (current.notes.length === 0) {
      return null;
    }
    // oxlint-disable-next-line no-unused-vars
    const notestats = current.notes.feedback.stats;
    const setstats = current.set.feedback.stats;
    return (
      <>
        <li>Code Notes:</li>
        <ul>
          <li>
            <details>
              <summary>Missing code notes: {setstats.missing_notes.size} (click to expand)</summary>
              <ul>
                {[...setstats.missing_notes.entries()]
                  .sort(([a, _1], [b, _2]) => a - b)
                  .map(([addr, loc]) => (
                    <Fragment key={addr}>
                      <li>
                        <code>{toDisplayHex(addr)}</code>
                      </li>
                      <ul>
                        {loc.map((x, i) => (
                          <li key={i}>used in {x}</li>
                        ))}
                      </ul>
                    </Fragment>
                  ))}
              </ul>
            </details>
          </li>
        </ul>
      </>
    );
  }

  // oxlint-disable-next-line unicorn/consistent-function-scoping
  function RichPresenceInfo() {
    if (!current.rp || !current.rp.feedback) {
      return null;
    }
    const stats = current.rp.feedback.stats;
    return (
      <>
        <li>Rich Presence:</li>
        <ul>
          <li>Is dynamic? {stats.is_dynamic_rp ? "Yes ✅" : "No ❌⚠️"}</li>
          <li>
            Display clauses: {stats.display_groups} ({stats.cond_display} conditional displays)
          </li>
          <ul>
            <li>Max lookups in one display: {stats.max_lookups}</li>
            <li>Min lookups in one display: {stats.min_lookups}</li>
          </ul>
        </ul>
      </>
    );
  }

  function ShowPercentage({ x }) {
    if (Array.isArray(x)) {
      x = x.length;
    }
    return (
      <>
        {x} ({Math.round((100 * x) / stats.achievement_count)}%)
      </>
    );
  }

  const achievements = current.set.getAchievements();
  const leaderboards = current.set.getLeaderboards();

  const set_contents = [
    [achievements.length, "achievement"],
    [leaderboards.length, "leaderboard"],
  ];

  let isSetReady = true;
  isSetReady &= current.set?.feedback?.pass();
  isSetReady &= current.notes?.feedback?.pass();
  isSetReady &= current.rp?.feedback?.pass();
  isSetReady &= [achievements, leaderboards].every((assetgroup) =>
    assetgroup.every((asset) => asset.feedback.pass()),
  );

  let setNotReady = null;
  if (!isSetReady && !achievements.some((ach) => ach.state === AssetState.CORE)) {
    setNotReady = (
      <div className="set-warning">
        <h2>⚠️ This set may not yet be ready for review ⚠️</h2>
        <p>
          There are several errors not yet addressed. Please check the feedback provided for each
          asset.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="main-header">
        <div className="float-right">
          <ConsoleIcon />
        </div>
        <div className="float-right">
          <button
            onClick={async () => {
              const ok = await copy_to_clipboard(
                buildSetReport(get_game_title(), collect_review_sections()),
              );
              setReviewStatus(ok ? "✅ Copied!" : "❌ Copy failed");
              setTimeout(() => setReviewStatus(null), 2000);
            }}
            title="Copy every finding in the set as Markdown"
            type="button"
          >
            {reviewStatus ?? "Copy Full Review"}
          </button>
        </div>
        <SetBadge />
        <h1 id="asset-title">{get_game_title()}</h1>
        <p>
          Set contains{" "}
          {set_contents
            .filter(([c, _]) => c)
            .map(([c, t]) => `${c} ${t}${c === 1 ? "" : "s"}`)
            .join(" and ")}
        </p>
      </div>
      {setNotReady}
      <ModifiedAssetsSummary />
      <div className="chart float-right">
        <h3>Achievement Typing</h3>
        <ChartCanvas
          setup={(canvas) => {
            const chartdata = [...stats.achievement_type.entries()];
            const COLORS = {
              "": "#FBDD70",
              progression: "#8DD7E1",
              win_condition: "#A36FD4",
              missable: "#F28590",
            };
            new Chart(canvas, {
              type: "doughnut",
              data: {
                labels: chartdata.map(([k, _]) => (k ? k : "(none)")),
                datasets: [
                  {
                    label: "achievement count",
                    data: chartdata.map(([_, v]) => v.length),
                    backgroundColor: chartdata.map(([k, _]) => COLORS[k]),
                  },
                ],
              },
            });
          }}
        />
      </div>
      <div className="stats">
        <h1>Statistics</h1>
        <ul>
          <li>Achievements</li>
          <ul>
            <li>
              {stats.achievement_count} achievements: <></>
              {[...stats.achievement_type.entries()]
                .map(([k, v]) => `${v.length} ${k ? k : "standard"}`)
                .join(", ")}
            </li>
            <li>Total points: {stats.total_points}</li>
            <li>
              <span title="~7 points per achievement is a good target">Average points</span>: ~
              {stats.avg_points.toFixed(1)} <AverageFeedback />
            </li>
          </ul>

          <li>Leaderboards</li>
          <ul>
            <li>
              {stats.leaderboard_count}{" "}
              <span title="breakdown determined heuristically">leaderboards</span>:
            </li>
            <ul>
              {[...stats.leaderboard_type.entries()].map(([k, v]) => (
                <li key={k}>
                  {v.length} {k}
                </li>
              ))}
            </ul>
            <li>Instant submission leaderboards: {stats.lb_instant_submission}</li>
            <li>Leaderboards with complex/conditional value: {stats.lb_conditional_value}</li>
          </ul>

          <RichPresenceInfo />

          <li>Proficiencies</li>
          <ul>
            <li>
              Flags used ({stats.all_flags.size}):{" "}
              <KeywordList list={[...stats.all_flags].map((x) => x.name)} />
            </li>
            <ul>
              {[...stats.all_flags].sort().map((k) => (
                <li key={k.name}>
                  <code>{k.name}</code> used in {stats.using_flag.get(k).size} achievements
                </li>
              ))}
              <li>
                Unused flags:{" "}
                <KeywordList
                  list={[...new Set(Object.values(ReqFlag)).difference(stats.all_flags)].map(
                    (x) => x.name,
                  )}
                />
              </li>
            </ul>
            <li>
              Comparisons used ({stats.all_cmps.size}): <KeywordList list={[...stats.all_cmps]} />
            </li>
            <li>
              Sizes used ({stats.all_sizes.size}):{" "}
              <KeywordList list={[...stats.all_sizes].map((x) => x.name)} />
            </li>
            <li>Achievement features:</li>
            <ul>
              <li>
                Achievements using <code>Delta</code> checks:{" "}
                <ShowPercentage x={stats.using_delta} />
              </li>
              <li>
                Achievements using <code>Prior</code>: <ShowPercentage x={stats.using_prior} />
              </li>
              <li>Achievements using Alt groups: {stats.using_alt_groups.length}</li>
              <li>Achievements using hitcounts: {stats.using_hitcounts.length}</li>
              <li>
                Achievements using{" "}
                <span title="requirements with a hitcount of 1">checkpoint hits</span>:{" "}
                {stats.using_checkpoint_hits.length}
              </li>
              <li>
                Achievements using{" "}
                <span title="BitX and BitCount memory sizes">bit operations</span>:{" "}
                {stats.using_bit_ops.length}
              </li>
              <li>
                Achievements using <span title="PauseIf with a hitcount">PauseLocks</span>:{" "}
                {stats.using_pauselock.length} ({stats.using_pauselock_alt_reset.length} with Alt
                reset)
              </li>
            </ul>
          </ul>

          <CodeNotesInfo />
        </ul>
      </div>
      <AssetFeedback issues={feedback.issues} />
    </>
  );
}

function has_issue(assets, warn) {
  return assets.some((asset) =>
    asset.feedback.issues.some((g) =>
      g.some((issue) => warn.includes(issue.type) && issue.severity > FeedbackSeverity.INFO),
    ),
  );
}

function CodeReviewOverview() {
  const feedback = current.set.feedback;
  const stats = feedback.stats;

  const achievements = current.set.getAchievements();
  const leaderboards = current.set.getLeaderboards();

  const all_assets = [...achievements, ...leaderboards];
  const all_stats = [
    ...achievements.map((ach) => ach.feedback.stats),
    ...leaderboards.map((lb) => lb.feedback.stats["STA"]),
  ];

  const set_contents = [
    [achievements.length, "achievement"],
    [leaderboards.length, "leaderboard"],
  ];

  const pOCA = all_stats.filter((stats) => stats.memlookups.size <= 1) / all_assets.length;
  const pDelta =
    all_assets.filter((asset) =>
      asset.feedback.issues.some((g) =>
        g.some((issue) => [Feedback.IMPROPER_DELTA, Feedback.MISSING_DELTA].includes(issue.type)),
      ),
    ) / all_assets.length;
  const pUUO =
    all_assets.filter((asset) =>
      asset.feedback.issues.some((g) =>
        g.some((issue) =>
          [Feedback.UUO_PAUSE, Feedback.UUO_RESET, Feedback.UUO_RNI].includes(issue.type),
        ),
      ),
    ) / all_assets.length;

  const review_row = [
    "",
    achievements.some((x) => x.achtype === "progression" || x.achtype === "win_condition") ? 1 : 0,
    "",
    "",
    "",
    leaderboards.length ? "" : 0,
    achievements.some((x) => x.achtype !== "") ? "" : 1,
    "",
    "",
    all_assets.some((asset) =>
      asset.feedback.issues.some((g) =>
        g.some((issue) => issue.type === "writing" && issue.severity > FeedbackSeverity.INFO),
      ),
    )
      ? 0
      : 1,
    "",
    "",
    "",
    current.notes.some((note) => note.type != null && note.type !== MemSize.BYTE) ? "" : 0,
    current.notes.some((note) => note.note.match(/bit\s?[0-7]/g) != null) ? 1 : 0,
    "",
    current.notes.some((note) => note.isProbablePointer()) ? 1 : "-",
    "",
    current.notes.feedback.issues.some((g) =>
      g.some((issue) => issue.type === "codenotes" && issue.severity > FeedbackSeverity.INFO),
    )
      ? 0
      : 1,
    "",
    has_issue(all_assets, [Feedback.IMPROPER_DELTA, Feedback.MISSING_DELTA]) ? 0 : 1,
    Math.min(1, stats.all_cmps.difference(new Set(["="])).size * 0.2),
    has_issue(all_assets, [Feedback.TYPE_MISMATCH]) ? 0 : 1,
    !stats.all_flags.has(ReqFlag.ANDNEXT)
      ? "-"
      : has_issue(all_assets, [Feedback.USELESS_ANDNEXT])
        ? 0
        : 1,
    !stats.using_alt_groups.length
      ? "-"
      : has_issue(all_assets, [Feedback.COMMON_ALT, Feedback.USELESS_ALT])
        ? 0
        : 1,
    !stats.all_flags.has(ReqFlag.ORNEXT) ? "-" : 1,
    !stats.using_hitcounts.length
      ? "-"
      : has_issue(all_assets, [Feedback.HIT_NO_RESET, Feedback.RESET_HITCOUNT_1])
        ? 0
        : 1,
    achievements.some((ach) => ach.feedback.stats.start_reset_trigger) ? "-" : 1,
    !stats.using_pauselock.length
      ? "-"
      : has_issue(all_assets, [Feedback.PAUSELOCK_NO_RESET])
        ? 0
        : 1,
    (current.rp?.display.length === 1 ? 0 : 0.5) + (current.rp?.lookups.size === 0 ? 0 : 0.5),
    !leaderboards.length ? "-" : 1,
    pOCA ? (-pOCA).toFixed(1) : "",
    "",
    pDelta ? (-pDelta).toFixed(1) : "",
    "",
    pUUO ? (-pUUO).toFixed(1) : "",
    !stats.using_prior.length ? "-" : 1,
    !stats.all_sizes.has(MemSize.BITCOUNT) ? "-" : 1,
    "",
    !all_stats.some((stats) => stats.addhits_complex_or > 0) ? "-" : 1,
    !stats.all_flags.has(ReqFlag.ADDSOURCE) && !stats.all_flags.has(ReqFlag.SUBSOURCE) ? "-" : 1,
    !achievements.some((ach) =>
      ["*", "/", "+", "-"].some((op) => ach.feedback.stats.source_modification.get(op) > 0),
    )
      ? "-"
      : 1,
    !all_stats.some((stats) => stats.pause_ifs > stats.pause_locks)
      ? "-"
      : has_issue(all_assets, [Feedback.UUO_PAUSE])
        ? 0
        : 1,
    "",
    !stats.all_flags.has(ReqFlag.RESETNEXTIF)
      ? "-"
      : has_issue(all_assets, [Feedback.UUO_RNI])
        ? 0
        : 1,
    ![ReqFlag.MEASURED, ReqFlag.MEASUREDP, ReqFlag.MEASUREDIF].some((flag) =>
      stats.all_flags.has(flag),
    )
      ? "-"
      : 1,
    !stats.all_flags.has(ReqFlag.TRIGGER)
      ? "-"
      : has_issue(all_assets, [Feedback.UUO_TRIGGER])
        ? 0
        : 1,
    !all_stats.some((stats) => stats.mixed_andor_chains > 0) ? "-" : 1,
    "",
    !stats.all_flags.has(ReqFlag.SUBHITS) ? "-" : 1,
    !stats.all_flags.has(ReqFlag.ADDADDRESS) ? "-" : 1,
    "",
    !stats.using_remember_recall.length ? "-" : 1,
    !achievements.some((ach) =>
      ["&", "^", "%"].some((op) => ach.feedback.stats.source_modification.get(op) > 0),
    )
      ? "-"
      : 1,
    ![
      MemSize.DBL32,
      MemSize.DBL32_BE,
      MemSize.FLOAT,
      MemSize.FLOAT_BE,
      MemSize.MBF32,
      MemSize.MBF32_LE,
    ].some((size) => stats.all_sizes.has(size))
      ? "-"
      : 1,
    "",
  ];

  // oxlint-disable-next-line unicorn/consistent-function-scoping
  function AssetCardList({ assets, label, warn = [] }) {
    const body = assets.map((asset) => (
      <AssetCard
        asset={asset}
        key={asset.id}
        warn={asset.feedback.issues.some((g) =>
          g.some((issue) => warn.includes(issue.type) && issue.severity > FeedbackSeverity.INFO),
        )}
      />
    ));

    return (
      <li>
        <details>
          <summary>
            {label}: {assets.length} asset{assets.length === 1 ? "" : "s"}
          </summary>
          <ul>{body}</ul>
        </details>
      </li>
    );
  }

  function AssetsByFlag({ flag, warn = [] }) {
    return (
      <AssetCardList
        assets={[...stats.using_flag.get(flag)]}
        label={
          <>
            <code>{flag.name}</code>
          </>
        }
        warn={warn}
      />
    );
  }

  return (
    <>
      <div className="main-header">
        <div className="float-right">
          <ConsoleIcon />
        </div>
        <SetBadge />
        <h1 id="asset-title">{get_game_title()}</h1>
        <div className="float-right">
          <button onClick={(e) => copy_to_clipboard(review_row.join("\t"))} type="button">
            Review Data
          </button>
        </div>
        <p>
          Set contains{" "}
          {set_contents
            .filter(([c, _]) => c)
            .map(([c, t]) => `${c} ${t}${c === 1 ? "" : "s"}`)
            .join(" and ")}
        </p>
      </div>
      <div>
        <h1>Basic Toolkit</h1>
        <ul>
          <li>
            Comparison Operators used: ({stats.all_cmps.size}):{" "}
            <KeywordList list={[...stats.all_cmps]} />
          </li>
          <ul>
            <AssetCardList
              assets={achievements.filter(
                (ach) =>
                  ach.feedback.stats.unique_cmps.size > 1 ||
                  !ach.feedback.stats.unique_cmps.has("="),
              )}
              label={<>Using non-equality comparators</>}
            />
          </ul>
          <li>
            Memory Sizes used ({stats.all_sizes.size}):{" "}
            <KeywordList list={[...stats.all_sizes].map((x) => x.name)} />
          </li>
          <ul>
            <AssetCardList
              assets={achievements.filter(
                (ach) =>
                  ach.feedback.stats.unique_sizes.size > 1 ||
                  !ach.feedback.stats.unique_sizes.has(MemSize.BYTE),
              )}
              label={
                <>
                  Using sizes other than <code>8-bit</code>
                </>
              }
              warn={[Feedback.TYPE_MISMATCH]}
            />
            <AssetCardList
              assets={stats.using_bit_ops}
              label={
                <>
                  Using bit operations (<code>BitX</code> or <code>BitCount</code>)
                </>
              }
            />
          </ul>
          <li>
            <code>Mem</code> & <code>Delta</code> Usage
          </li>
          <ul>
            <AssetCardList
              assets={achievements.filter((ach) =>
                ach.feedback.issues.some((g) => g.some((x) => x.type === Feedback.MISSING_DELTA)),
              )}
              label={
                <>
                  Lacking <code>Delta</code>
                </>
              }
            />
            <AssetCardList
              assets={achievements.filter((ach) =>
                ach.feedback.issues.some((g) => g.some((x) => x.type === Feedback.IMPROPER_DELTA)),
              )}
              label={
                <>
                  Using <code>Delta</code> improperly or insufficiently
                </>
              }
            />
          </ul>
          <AssetCardList
            assets={stats.using_alt_groups}
            label={<>Using Alt groups</>}
            warn={[Feedback.COMMON_ALT, Feedback.USELESS_ALT]}
          />
          <li>Hitcounts</li>
          <ul>
            <AssetCardList
              assets={stats.using_checkpoint_hits}
              label={<>Using Checkpoint hits</>}
              warn={[Feedback.HIT_NO_RESET, Feedback.RESET_HITCOUNT_1]}
            />
            <AssetCardList
              assets={stats.using_hitcounts}
              label={
                <>
                  Using hitcounts (<code>&gt;1</code>)
                </>
              }
              warn={[Feedback.HIT_NO_RESET]}
            />
          </ul>
          <li>Specific Flags</li>
          <ul>
            <AssetsByFlag
              flag={ReqFlag.RESETIF}
              warn={[
                Feedback.PAUSELOCK_NO_RESET,
                Feedback.HIT_NO_RESET,
                Feedback.UUO_RESET,
                Feedback.RESET_HITCOUNT_1,
              ]}
            />
            <AssetsByFlag
              flag={ReqFlag.PAUSEIF}
              warn={[Feedback.PAUSELOCK_NO_RESET, Feedback.UUO_PAUSE, Feedback.PAUSING_MEASURED]}
            />
          </ul>
        </ul>
        <h1>Intermediate Toolkit</h1>
        <ul>
          <AssetCardList
            assets={achievements.filter((ach) => ach.feedback.stats.priors > 0)}
            label={
              <>
                Using <code>Prior</code>
              </>
            }
            warn={[Feedback.BAD_PRIOR]}
          />
          <li>Specific Flags</li>
          <ul>
            <AssetsByFlag flag={ReqFlag.ANDNEXT} warn={[Feedback.USELESS_ANDNEXT]} />
            <AssetsByFlag flag={ReqFlag.ADDHITS} warn={[Feedback.HIT_NO_RESET]} />
          </ul>
        </ul>
        <h1>Advanced Toolkit</h1>
        <ul>
          <li>PauseLocks</li>
          <ul>
            <AssetCardList
              assets={stats.using_pauselock}
              label={<>PauseLocks</>}
              warn={[Feedback.PAUSELOCK_NO_RESET]}
            />
            <AssetCardList
              assets={stats.using_pauselock_alt_reset}
              label={<>PauseLocks (with Alt resets)</>}
              warn={[Feedback.PAUSELOCK_NO_RESET]}
            />
          </ul>
          <AssetCardList
            assets={achievements.filter((ach) => ach.feedback.stats.mem_del > 0)}
            label={
              <>
                Using a <code>Mem</code> &ne; <code>Delta</code> counter
              </>
            }
            warn={[]}
          />
          <li>Specific Flags</li>
          <ul>
            <AssetsByFlag
              flag={ReqFlag.RESETNEXTIF}
              warn={[Feedback.PAUSELOCK_NO_RESET, Feedback.HIT_NO_RESET, Feedback.UUO_RNI]}
            />
            <AssetsByFlag flag={ReqFlag.SUBHITS} warn={[Feedback.HIT_NO_RESET]} />
            <AssetsByFlag flag={ReqFlag.ADDADDRESS} warn={[Feedback.STALE_ADDADDRESS]} />
            <AssetsByFlag flag={ReqFlag.ADDSOURCE} warn={[]} />
            <AssetsByFlag flag={ReqFlag.SUBSOURCE} warn={[]} />
            <AssetsByFlag flag={ReqFlag.MEASURED} warn={[Feedback.PAUSING_MEASURED]} />
            <AssetsByFlag flag={ReqFlag.MEASUREDP} warn={[Feedback.PAUSING_MEASURED]} />
            <AssetsByFlag flag={ReqFlag.MEASUREDIF} warn={[]} />
            <AssetsByFlag flag={ReqFlag.TRIGGER} warn={[]} />
            <AssetsByFlag flag={ReqFlag.ORNEXT} warn={[]} />
            <AssetCardList
              assets={stats.using_remember_recall}
              label={
                <>
                  <code>Remember</code>+<code>Recall</code>
                </>
              }
              warn={[]}
            />
          </ul>
          <li>Source modification:</li>
          <ul>
            <AssetCardList
              assets={achievements.filter((ach) =>
                ["*", "/", "+", "-"].some(
                  (op) => ach.feedback.stats.source_modification.get(op) > 0,
                ),
              )}
              label={
                <>
                  Using <code>*</code>, <code>/</code>, <code>+</code>, <code>-</code>
                </>
              }
              warn={[]}
            />
            <AssetCardList
              assets={achievements.filter((ach) =>
                ["&", "^", "%"].some((op) => ach.feedback.stats.source_modification.get(op) > 0),
              )}
              label={
                <>
                  Using <code>&</code>, <code>^</code>, <code>%</code>
                </>
              }
              warn={[]}
            />
          </ul>
          <AssetCardList
            assets={achievements.filter((ach) => ach.feedback.stats.mixed_andor_chains > 0)}
            label={
              <>
                Using complex <code>AndNext</code>+<code>OrNext</code> chains
              </>
            }
            warn={[]}
          />
          <AssetCardList
            assets={achievements.filter((ach) => ach.feedback.stats.addhits_complex_or > 0)}
            label={
              <>
                Using <code>AddHits</code> as complex-<code>OR</code>
              </>
            }
            warn={[Feedback.HIT_NO_RESET]}
          />
        </ul>
        <h1>Other Details</h1>
        <ul>
          <AssetCardList
            assets={achievements.filter((ach) => ach.points === 25)}
            label={<>Achievements worth 25 points</>}
            warn={[]}
          />
          <AssetCardList
            assets={achievements.filter((ach) => ach.points > 25)}
            label={<>Achievements worth &gt;25 points</>}
            warn={[]}
          />
        </ul>
        <h1>Badge Grid</h1>
        <BadgeGrid set={current.set} />
      </div>
    </>
  );
}

function CodeNotesTable({ notes = [], issues = [] }) {
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  function toDisplayHex(addr) {
    return "0x" + addr.toString(16).padStart(8, "0");
  }

  // oxlint-disable-next-line unicorn/consistent-function-scoping
  function LinkToAsset({ asset }) {
    const handleclick = (e) => {
      jump_to_asset(asset);
      TooltipManager.startHide();
      e.preventDefault();
      return false;
    };

    const route = document.getElementById(asset?.toRefString?.())?.getAttribute("data-route");
    // oxlint-disable-next-line @nkzw/no-instanceof
    if (asset instanceof Achievement) {
      return (
        <>
          🏆{" "}
          <a href={`#!/game/${current.id}${route}`} onClick={handleclick}>
            {asset.title}
          </a>
        </>
      );
      // oxlint-disable-next-line @nkzw/no-instanceof
    } else if (asset instanceof Leaderboard) {
      return (
        <>
          📊{" "}
          <a href={`#!/game/${current.id}${route}`} onClick={handleclick}>
            {asset.title}
          </a>
        </>
      );
    } else {
      return <>{asset}</>;
    }
  }

  issues = [].concat(...issues);
  return (
    <div className="data-table">
      <table className="code-notes">
        <thead>
          <tr className="group-hdr header">
            <td colSpan="4">Code Notes</td>
          </tr>
          <tr className="col-hdr header">
            <td>Address</td>
            <td>Note</td>
            <td>Author</td>
            <td>Assets</td>
          </tr>
        </thead>
        <tbody>
          {notes.map((note) => (
            <tr
              className={issues.some((x) => x.target === note) ? "warn" : ""}
              id={note.toRefString()}
              key={note.addr}
            >
              <td>
                {toDisplayHex(note.addr)}
                {note.isArray() ? (
                  <>
                    <br />
                    &#x2010;&nbsp;{toDisplayHex(note.addr + note.size - 1)}
                  </>
                ) : (
                  <></>
                )}
              </td>
              <td>
                <pre>{note.note}</pre>
              </td>
              <td>
                <span
                  className="tooltip"
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    TooltipManager.show(<pre>{note.author}</pre>, rect);
                  }}
                  onMouseLeave={() => TooltipManager.startHide()}
                >
                  <a href={`https://retroachievements.org/user/${note.author}`}>
                    <img
                      height="24"
                      src={`https://media.retroachievements.org/UserPic/${note.author}.png`}
                      width="24"
                    />
                  </a>
                </span>
              </td>
              <td>
                <span
                  className="tooltip"
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    TooltipManager.show(
                      <ul style={{ width: "500px", listStyleType: "none", padding: 0, margin: 0 }}>
                        {note.assetList.map((a, i) => (
                          <li key={i}>
                            <LinkToAsset asset={a} />
                          </li>
                        ))}
                      </ul>,
                      rect,
                    );
                  }}
                  onMouseLeave={() => TooltipManager.startHide()}
                >
                  {note.assetList.length}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeNotesOverview() {
  const feedback = current.notes.feedback;
  const feedback_targets = new Set([].concat(...feedback.issues).map((x) => x.target));
  const stats = feedback.stats;

  const authors = new Set(current.notes.map((note) => note.author));
  const [authState, setAuthState] = useState(
    Object.fromEntries([...authors].map((a) => [a, true])),
  );
  const [warnsOnly, setWarnsOnly] = useState(false);
  const [hideUnused, setHideUnused] = useState(false);
  const [hideUsed, setHideUsed] = useState(false);

  let displaynotes = current.notes.filter((note) => authState[note.author]);
  if (warnsOnly) {
    displaynotes = displaynotes.filter((note) => feedback_targets.has(note));
  }
  if (hideUnused) {
    displaynotes = displaynotes.filter((note) => note.assetList.length > 0);
  }
  if (hideUsed) {
    displaynotes = displaynotes.filter((note) => note.assetList.length === 0);
  }
  const displayissues = feedback.issues.filter(
    (issue) => !issue.target || displaynotes.includes(issue.target),
  );
  const displayaudit = (current.notes.audit ?? []).filter((x) => displaynotes.includes(x.note));
  const [reportStatus, setReportStatus] = useState(null);

  return (
    <>
      <div className="main-header">
        <div className="float-right">
          <ConsoleIcon />
        </div>
        <SetBadge href={`https://retroachievements.org/codenotes.php?g=${current.id}`} />
        <h1 id="asset-title">{get_game_title()}</h1>
        <ul className="list-inside">
          <li>
            <a href={`https://retroachievements.org/codenotes.php?g=${current.id}`}>
              {current.notes.length} code notes
            </a>{" "}
            <></>
            by {authors.size} author(s):{" "}
            {[...authors].map((name, i) => (
              <Fragment key={name}>
                {i > 0 ? " | " : ""}
                <span>
                  <input
                    defaultChecked
                    onChange={(e) => {
                      setAuthState(
                        Object.assign({}, authState, { [name]: e.currentTarget.checked }),
                      );
                    }}
                    type="checkbox"
                  />{" "}
                  <a href={`https://retroachievements.org/user/${name}`}>{name}</a>
                </span>
              </Fragment>
            ))}
          </li>
          <li>
            <label htmlFor="warnsOnly">Only show warnings</label>
            <input
              id="warnsOnly"
              onChange={(e) => {
                setWarnsOnly(e.currentTarget.checked);
              }}
              type="checkbox"
            />
            {" | "}
            <label htmlFor="hideUnused">Hide unused notes</label>
            <input
              id="hideUnused"
              onChange={(e) => {
                setHideUnused(e.currentTarget.checked);
              }}
              type="checkbox"
            />
            {" | "}
            <label htmlFor="hideUsed">Hide used notes</label>
            <input
              id="hideUsed"
              onChange={(e) => {
                setHideUsed(e.currentTarget.checked);
              }}
              type="checkbox"
            />
          </li>
        </ul>
      </div>

      <button
        className="float-right"
        onClick={() => {
          let backupTxt = "";

          for (const note of displaynotes) {
            // Checks if the type property exists to inject the size tag (e.g., [8-bit])
            const sizeTag = note.type && note.type.name ? `[${note.type.name}] ` : "";

            // toDisplayHex is already a local function that formats to the 0x00000000 pattern
            backupTxt += `${toDisplayHex(note.addr)}: ${sizeTag}${note.note}\n\n`;
          }

          // Generates the Blob file in memory to force the browser download
          const blob = new Blob([backupTxt.trim()], { type: "text/plain" });
          const url = window.URL.createObjectURL(blob);

          const e = document.createElement("a");
          e.style.display = "none";
          e.href = url;
          e.download = `${current.id}-Backup-Notes.txt`; // Names the file with the game ID

          document.body.append(e);
          e.click();

          window.URL.revokeObjectURL(url);
          document.body.removeChild(e);
        }}
        style={{ marginRight: "10px" }}
        type="button"
      >
        Download Backup
      </button>

      <button
        className="float-right"
        disabled={displayaudit.length === 0}
        onClick={async () => {
          const ok = await copy_to_clipboard(
            Auditor.formatReport(displayaudit, get_game_title() ?? ""),
          );
          setReportStatus(ok ? "✅ Copied!" : "❌ Copy failed");
          setTimeout(() => setReportStatus(null), 2000);
        }}
        style={{ marginRight: "10px" }}
        title="Copy the code note audit as Markdown"
        type="button"
      >
        {reportStatus ?? `Copy Report (${displayaudit.length})`}
      </button>

      <button
        className="float-right"
        disabled={displayaudit.length === 0}
        onClick={() =>
          download_user_file(displayaudit.map(({ addr, fix }) => ({ addr, note: fix })))
        }
        style={{ marginRight: "10px" }}
        title="Download a User.txt with every suggested correction, to import in RAIntegration"
        type="button"
      >
        Apply Fixes ({displayaudit.length})
      </button>

      <button
        className="float-right"
        onClick={() => download_user_file(displaynotes.map((n) => ({ addr: n.addr, note: "" })))}
        title="Download a User.txt that deletes the listed notes"
        type="button"
      >
        Quick Delete
      </button>
      <CodeNotesTable issues={displayissues} notes={displaynotes} />

      <div className="stats">
        <h1>Statistics</h1>
        <ul>
          <li>
            {stats.notes_count} code notes ({stats.notes_used} used, {stats.notes_unused} unused)
          </li>
          <li>Sizes noted</li>
          <ul>
            {[...stats.size_counts.entries()].map(([k, v]) => (
              <li key={k}>
                <code>{k}</code>: {v}
              </li>
            ))}
          </ul>
          <li>Author contributions</li>
          <ul>
            {[...stats.author_counts.entries()].map(([k, v]) => (
              <li key={k}>
                <a href={`https://retroachievements.org/user/${k}`}>{k}</a>: {v} (
                {((100 * v) / stats.notes_count).toFixed(1)}%)
              </li>
            ))}
          </ul>
        </ul>
      </div>

      <AssetFeedback issues={displayissues} />
    </>
  );
}

// --- RICH PRESENCE SIMULATOR & UI ---

function addLookups(t) {
  return t.replaceAll(
    /(@(\S*)\((.+?)\))/gi,
    '<span class="lookup">@<span class="link">$2</span>(<span class="value logic">$3</span>)</span>',
  );
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHTML(text) {
  return text.replaceAll(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function HighlightedRichPresence({ script, onLogicSelected = null }) {
  if (!script) {
    return null;
  }

  // oxlint-disable-next-line react-hooks/rules-of-hooks
  const ref = useRef();
  // oxlint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    const root = ref.current;
    for (const elt of root.querySelectorAll(".link")) {
      elt.onclick = (x) => {
        document
          .getElementById(`def-${elt.innerText}`)
          .scrollIntoView({ behavior: "smooth", block: "nearest" });
      };
    }

    for (const elt of root.querySelectorAll(".logic")) {
      elt.onclick = (x) => {
        for (const e2 of root.querySelectorAll(".logic.selected")) {
          e2.classList.remove("selected");
        }
        elt.classList.add("selected");

        const logic = Logic.fromString(elt.innerText, elt.classList.contains("value"));
        if (onLogicSelected) {
          onLogicSelected(logic);
        }
      };
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let display = false;
  let rptext = script
    .split(/\r\n|(?!\r\n)[\n-\r\u0085\u2028\u2029]/g)
    .map((line) => {
      // the script is rendered as HTML, so escape it before adding highlight markup
      line = escapeHTML(line.trim());
      if (display) {
        line = line.startsWith("?")
          ? line.replaceAll(
              /\?(.+)\?(.*)/g,
              (_, p1, p2) => `?<span class="condition logic">${p1}</span>?${addLookups(p2)}`,
            )
          : addLookups(line);
      }
      if (line.startsWith("Display:")) {
        // oxlint-disable-next-line react/immutability
        display = true;
      }
      return line;
    })
    .join("\n");
  rptext = rptext.replaceAll(
    /((Lookup|Format|Display):(\S+))/g,
    '<span class="header" id="def-$3">$1</span>',
  );

  return (
    <div className="rich-presence clear">
      <pre>
        <code dangerouslySetInnerHTML={{ __html: rptext }} ref={ref}></code>
      </pre>
    </div>
  );
}

function formatRPSimulationValue(value, format, parameter, scoreVal) {
  let displayValue = value;

  if (parameter) {
    let maxVal = 0xffffffff;
    if (parameter.includes("8-bit") || parameter.includes("Bit") || parameter.includes("4")) {
      maxVal = 0xff;
    } else if (parameter.includes("16-bit")) {
      maxVal = 0xffff;
    } else if (parameter.includes("24-bit")) {
      maxVal = 0xffffff;
    }
    displayValue = value % (maxVal + 1);
  }

  switch (format.toUpperCase()) {
    case "SCORE":
      return String(scoreVal).padStart(6, "0");
    case "FRAMES":
      return `${Math.floor(displayValue / 3600)}:${String(Math.floor((displayValue / 60) % 60)).padStart(2, "0")}.${String(Math.floor((displayValue * 100) / 60) % 100).padStart(2, "0")}`;
    case "MILLISECS":
      return `${Math.floor(displayValue / 6000)}:${String(Math.floor((displayValue / 100) % 60)).padStart(2, "0")}.${String(displayValue % 100).padStart(2, "0")}`;
    case "SECS":
      return `${Math.floor(displayValue / 60)}:${String(displayValue % 60).padStart(2, "0")}`;
    case "MINUTES":
      return `${Math.floor(displayValue / 60)}h${String(displayValue % 60).padStart(2, "0")}`;
    case "SECS_AS_MINS":
      return `${Math.floor(displayValue / 3600)}h${String(Math.floor((displayValue / 60) % 60)).padStart(2, "0")}:${String(displayValue % 60).padStart(2, "0")}`;
    case "UNSIGNED":
      return String(displayValue >>> 0);
    case "TENS":
      return String(displayValue * 10);
    case "HUNDREDS":
      return String(displayValue * 100);
    case "THOUSANDS":
      return String(displayValue * 1000);
    case "FIXED1":
      return (displayValue / 10.0).toFixed(1);
    case "FIXED2":
      return (displayValue / 100.0).toFixed(2);
    case "FIXED3":
      return (displayValue / 1000.0).toFixed(3);
    case "FLOAT1":
      return (Math.random() * 1000).toFixed(1);
    case "FLOAT2":
      return (Math.random() * 1000).toFixed(2);
    case "FLOAT3":
      return (Math.random() * 1000).toFixed(3);
    case "ASCIICHAR":
      return displayValue >= 0x20 && displayValue <= 0x7e ? String.fromCharCode(displayValue) : "?";
    case "UNICODECHAR":
      return displayValue >= 0x20 ? String.fromCharCode(displayValue) : "?";
    case "VALUE":
    default:
      return String(displayValue);
  }
}

function getFormattedPreview(ds, script) {
  let sb = "";
  const builtInMacros = {
    Number: "VALUE",
    Unsigned: "UNSIGNED",
    Score: "SCORE",
    Centiseconds: "MILLISECS",
    Seconds: "SECS",
    Minutes: "MINUTES",
    Fixed1: "FIXED1",
    Fixed2: "FIXED2",
    Fixed3: "FIXED3",
    Float1: "FLOAT1",
    Float2: "FLOAT2",
    Float3: "FLOAT3",
    ASCIIChar: "ASCIICHAR",
    UnicodeChar: "UNICODECHAR",
  };

  for (const part of ds.parts) {
    if (part.isMacro) {
      const lookup = script.scriptLookups.find(
        (l) => l.name.toLowerCase() === part.text.toLowerCase(),
      );
      if (lookup) {
        if (lookup.entries.length > 0) {
          sb += lookup.defaultVal || "";
        } else {
          sb += formatRPSimulationValue(0, lookup.format, part.parameter, 0);
        }
      } else if (builtInMacros[part.text]) {
        sb += formatRPSimulationValue(0, builtInMacros[part.text], part.parameter, 0);
      } else {
        sb += `{${part.text}}`;
      }
    } else {
      sb += part.text;
    }
  }
  sb = sb.replaceAll(/\s+/g, " ").trim();
  return (ds.isDefault ? "[Default] " : "") + sb;
}

function RARPLivePreview({ script, displayString }) {
  const [tick, setTick] = useState(0);
  const [score, setScore] = useState(() => Math.floor(Math.random() * 10_000));
  const lookupCache = useRef({});

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
      setScore((s) => Math.max(0, s + Math.floor(Math.random() * 101) - 50));
    }, 1000);
    return () => clearInterval(timer);
  }, [displayString]);

  if (!displayString) {
    return (
      <div className="rarp-live-preview" style={{ color: "#666" }}>
        No string selected
      </div>
    );
  }

  let previewText = "";
  const builtInMacros = {
    Number: "VALUE",
    Unsigned: "UNSIGNED",
    Score: "SCORE",
    Centiseconds: "MILLISECS",
    Seconds: "SECS",
    Minutes: "MINUTES",
    Fixed1: "FIXED1",
    Fixed2: "FIXED2",
    Fixed3: "FIXED3",
    Float1: "FLOAT1",
    Float2: "FLOAT2",
    Float3: "FLOAT3",
    ASCIIChar: "ASCIICHAR",
    UnicodeChar: "UNICODECHAR",
  };

  for (const part of displayString.parts) {
    if (!part.isMacro) {
      previewText += part.text;
      continue;
    }

    const lookup = script.scriptLookups.find(
      (l) => l.name.toLowerCase() === part.text.toLowerCase(),
    );
    if (lookup) {
      if (lookup.entries.length > 0) {
        // oxlint-disable-next-line react/refs
        if (!lookupCache.current[lookup.name] || tick % 3 === 0) {
          // oxlint-disable-next-line react/purity
          const randomEntry = lookup.entries[Math.floor(Math.random() * lookup.entries.length)];
          // oxlint-disable-next-line react/refs
          lookupCache.current[lookup.name] = randomEntry
            ? randomEntry.value
            : lookup.defaultVal || "";
        }
        // oxlint-disable-next-line react/refs
        previewText += lookupCache.current[lookup.name];
      } else {
        previewText += formatRPSimulationValue(tick, lookup.format, part.parameter, score);
      }
    } else if (builtInMacros[part.text]) {
      previewText += formatRPSimulationValue(tick, builtInMacros[part.text], part.parameter, score);
    } else {
      previewText += `{${part.text}}`;
    }
  }

  return <div className="rarp-live-preview"> {previewText}</div>;
}

const getIcon = (severity) => {
  if (severity >= 3) {
    return "❌";
  }
  if (severity === 2) {
    return "⚠️";
  }
  if (severity === 1) {
    return "ℹ️";
  }
  return "✔️";
};

const arrowStyle = (isOpen) => ({
  width: "20px",
  display: "inline-block",
  textAlign: "center",
  fontSize: "10px",
  transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
  transition: "transform 0.3s ease",
});

function RARPTreeView({
  script,
  selectedItem,
  setSelectedItem,
  dsSeverities,
  lookupSeverities,
  formatterSeverities,
  sidebarWidth,
}) {
  const [expanded, setExpanded] = useState({ lookups: true, formatters: true, display: true });
  const toggle = (cat) => setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));

  const formatters = script.scriptLookups.filter(
    (l) => l.entries.length === 0 && l.defaultVal === null,
  );
  const lookups = script.scriptLookups.filter((l) => l.entries.length > 0 || l.defaultVal !== null);

  return (
    <div className="rarp-sidebar" style={{ flexBasis: sidebarWidth }}>
      <div className="rarp-tree-group" onClick={() => toggle("lookups")}>
        <span style={arrowStyle(expanded.lookups)}>▶</span> Lookups
      </div>
      <div className={`explainer-anim-wrapper ${expanded.lookups ? "open" : ""}`}>
        <div className="explainer-anim-inner">
          {lookups.map((l, i) => {
            const sev = lookupSeverities[i] || 0;
            const icon = getIcon(sev);
            return (
              <div
                className={`rarp-tree-node ${i % 2 === 0 ? "striped" : ""} ${selectedItem.type === "lookup" && selectedItem.index === i ? "selected" : ""}`}
                key={`l-${i}`}
                onClick={() => setSelectedItem({ type: "lookup", index: i, macro: "Condition" })}
                title={l.name}
              >
                <span style={{ flexShrink: 0 }}>{icon}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{l.name}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rarp-tree-group" onClick={() => toggle("formatters")}>
        <span style={arrowStyle(expanded.formatters)}>▶</span> Formatters
      </div>
      <div className={`explainer-anim-wrapper ${expanded.formatters ? "open" : ""}`}>
        <div className="explainer-anim-inner">
          {formatters.map((f, i) => {
            const sev = formatterSeverities[i] || 0;
            const icon = getIcon(sev);
            return (
              <div
                className={`rarp-tree-node ${i % 2 === 0 ? "striped" : ""} ${selectedItem.type === "formatter" && selectedItem.index === i ? "selected" : ""}`}
                key={`f-${i}`}
                onClick={() => setSelectedItem({ type: "formatter", index: i, macro: "Condition" })}
                title={f.name}
              >
                <span style={{ flexShrink: 0 }}>{icon}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rarp-tree-group" onClick={() => toggle("display")}>
        <span style={arrowStyle(expanded.display)}>▶</span> Display Logic
      </div>
      <div className={`explainer-anim-wrapper ${expanded.display ? "open" : ""}`}>
        <div className="explainer-anim-inner">
          {script.displayStrings.map((ds, i) => {
            const displayTitle = getFormattedPreview(ds, script);
            const sev = dsSeverities[i] || 0;
            let icon = getIcon(sev);
            if (ds.isDefault && sev === 0) {
              icon = "⭐";
            }

            return (
              <div
                className={`rarp-tree-node ${i % 2 === 0 ? "striped" : ""} ${selectedItem.type === "display" && selectedItem.index === i ? "selected" : ""}`}
                key={`d-${i}`}
                onClick={() => setSelectedItem({ type: "display", index: i, macro: "Condition" })}
                title={displayTitle}
              >
                <span style={{ flexShrink: 0 }}>{icon}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{displayTitle}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RARPDisplayEditor({ ds, isHex, toggleHex, selectedItem, setSelectedItem }) {
  const selectedLogic = selectedItem.macro || "Condition";
  const macros = ds.parts.filter((p) => p.isMacro);
  const macroNames = [...new Set(macros.map((m) => m.text))];

  // Resizer state for the top row panels
  const [templateWidth, setTemplateWidth] = useState(55); // percentage
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDragging) {
        return;
      }
      // Estimate percentage based on window width minus sidebar
      const containerWidth = document.querySelector(".rarp-top-row").offsetWidth;
      const containerLeft = document.querySelector(".rarp-top-row").getBoundingClientRect().left;
      let newPct = ((e.clientX - containerLeft) / containerWidth) * 100;
      if (newPct < 20) {
        newPct = 20;
      }
      if (newPct > 80) {
        newPct = 80;
      }
      setTemplateWidth(newPct);
    };

    const handleMouseUp = () => {
      if (isDragging) {
        setIsDragging(false);
      }
    };

    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
    } else {
      document.body.style.cursor = "default";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  const handleLogicChange = (e) => {
    setSelectedItem({ ...selectedItem, macro: e.target.value });
  };

  let tableContent = null;

  if (selectedLogic === "Condition") {
    tableContent = ds.condition ? (
      <div className="data-table">
        <LogicTable isHex={isHex} logic={ds.condition} toggleHex={toggleHex} />
      </div>
    ) : (
      <div style={{ padding: "15px", color: "#888", fontStyle: "italic" }}>
        No condition defined (Default String).
      </div>
    );
  } else {
    const targetMacro = macros.find((m) => m.text === selectedLogic);
    if (targetMacro) {
      let macroLogic;
      try {
        macroLogic = Logic.fromString(targetMacro.parameter, true);
      } catch {
        //
      }

      tableContent = (
        <div>
          {macroLogic ? (
            <div className="data-table">
              <LogicTable isHex={isHex} logic={macroLogic} toggleHex={toggleHex} />
            </div>
          ) : (
            <div style={{ padding: "15px", color: "red" }}>Invalid logic</div>
          )}
        </div>
      );
    }
  }

  const rawTemplate = ds.parts.map((p) => (p.isMacro ? `{${p.text}}` : p.text)).join("");

  return (
    <div className="rarp-main" id={ds.toRefString()}>
      <div className="rarp-top-row flex-panel-container">
        <div
          className="rarp-panel"
          style={{ flexBasis: `${templateWidth}%`, flexGrow: 0, flexShrink: 0 }}
        >
          <div className="rarp-panel-header">Display String Template</div>
          <div className="rarp-panel-content">
            <p className="rarp-template-text">{rawTemplate}</p>
          </div>
        </div>

        {/* Horizontal Splitter */}
        <div
          className={`resizer-x ${isDragging ? "active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
        ></div>

        <div
          className="rarp-panel"
          style={{ flexBasis: `calc(${100 - templateWidth}% - 5px)`, flexGrow: 0, flexShrink: 0 }}
        >
          <div className="rarp-panel-header">Live Preview Panel</div>
          <div className="rarp-panel-content">
            <RARPLivePreview displayString={ds} script={current.rp} />
          </div>
        </div>
      </div>

      <div className="rarp-panel" style={{ flex: "2" }}>
        <div className="rarp-panel-header">Logic Explorer</div>
        <div className="rarp-logic-toolbar">
          <select className="rarp-logic-select" onChange={handleLogicChange} value={selectedLogic}>
            <option value="Condition">Condition</option>
            {macroNames.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="rarp-panel-content" style={{ padding: 0 }}>
          {tableContent}
        </div>
      </div>
    </div>
  );
}

function RARPDetailView({ script, selectedItem, setSelectedItem, isHex, toggleHex }) {
  if (selectedItem.type === "display") {
    const ds = script.displayStrings[selectedItem.index];
    if (!ds) {
      return null;
    }
    return (
      <RARPDisplayEditor
        ds={ds}
        isHex={isHex}
        selectedItem={selectedItem}
        setSelectedItem={setSelectedItem}
        toggleHex={toggleHex}
      />
    );
  }

  const formatters = script.scriptLookups.filter(
    (l) => l.entries.length === 0 && l.defaultVal === null,
  );
  const lookups = script.scriptLookups.filter((l) => l.entries.length > 0 || l.defaultVal !== null);

  const item =
    selectedItem.type === "lookup" ? lookups[selectedItem.index] : formatters[selectedItem.index];
  if (!item) {
    return null;
  }

  return (
    <div className="rarp-main" id={item.toRefString()}>
      <div className="rarp-panel">
        <div className="rarp-panel-header">
          {selectedItem.type === "lookup" ? "Lookup Dictionary" : "Formatter Definition"}
        </div>
        <div className="rarp-panel-content">
          <h2 style={{ marginTop: 0 }}>{item.name}</h2>
          <p style={{ color: "#888" }}>
            Format Type: <strong>{item.format}</strong>
          </p>

          {selectedItem.type === "lookup" && (
            <div className="data-table" style={{ marginTop: "20px" }}>
              <table>
                <thead>
                  <tr className="col-hdr header">
                    <td>Key (Hex)</td>
                    <td>Key (Dec)</td>
                    <td>Value</td>
                  </tr>
                </thead>
                <tbody>
                  {item.entries
                    .sort((a, b) => a.keyValue - b.keyValue)
                    .map((e, i) => (
                      <tr key={i}>
                        <td>
                          0x{e.keyValue.toString(16).toUpperCase()}{" "}
                          {e.keyValueEnd && e.keyValueEnd !== e.keyValue
                            ? `- 0x${e.keyValueEnd.toString(16).toUpperCase()}`
                            : ""}
                        </td>
                        <td>
                          {e.keyValue}{" "}
                          {e.keyValueEnd && e.keyValueEnd !== e.keyValue
                            ? `- ${e.keyValueEnd}`
                            : ""}
                        </td>
                        <td style={{ "white-space": "pre-wrap" }}>{e.value}</td>
                      </tr>
                    ))}
                  {item.defaultVal !== null && (
                    <tr>
                      <td colSpan="2" style={{ color: "#999" }}>
                        * (Default/Fallback)
                      </td>
                      <td style={{ color: "#999" }}>{item.defaultVal}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Extract text from React detail elements to map null-target issues
// oxlint-disable-next-line no-unused-vars
function extractReactText(node) {
  if (!node) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(extractReactText).join("");
  }
  if (node.props && node.props.children) {
    return extractReactText(node.props.children);
  }
  return "";
}

function RPAssetFeedback({ issues, onIssueClick }) {
  if (!issues || issues.length === 0 || !issues.some((g) => g.length > 0)) {
    return null;
  }
  return (
    <div className="feedback">
      <h1>Feedback</h1>
      {issues.map((group, i) => {
        if (!group || group.length === 0) {
          return null;
        }
        return (
          <Fragment key={i}>
            <h2>{group.label}</h2>
            <ul>
              {group.map((issue, j) => (
                <li key={j}>
                  {issue.target ? (
                    <sup>
                      (
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          onIssueClick(issue);
                        }}
                      >
                        #{j + 1}
                      </a>
                      )
                    </sup>
                  ) : null}{" "}
                  {issue.type.desc}
                  {issue.type.ref.map((r, k) => (
                    <Fragment key={k}>
                      <sup key={r}>
                        [
                        <a href={r} rel="noreferrer" target="_blank">
                          ref
                        </a>
                        ]
                      </sup>
                    </Fragment>
                  ))}
                  {issue.detail}
                </li>
              ))}
            </ul>
          </Fragment>
        );
      })}
    </div>
  );
}

function RichPresenceOverview() {
  const feedback = current.rp.feedback;
  const script = current.rp;

  const [viewMode, setViewMode] = useState(() => localStorage.getItem("pref-rpViewMode") || "rarp");
  const [selectedItem, setSelectedItem] = useState({
    type: "display",
    index: 0,
    macro: "Condition",
  });
  const [logicData, setLogicData] = useState(null);

  // Splitter State for RP UI Sidebar
  const [sidebarWidth, setSidebarWidth] = useState(350);
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);

  const [isHex, setIsHex] = useState(() => localStorage.getItem("pref-isHex") === "true");
  const toggleHex = () => {
    const newVal = !isHex;
    setIsHex(newVal);
    localStorage.setItem("pref-isHex", newVal);
  };

  const toggleViewMode = () => {
    const newMode = viewMode === "rarp" ? "raw" : "rarp";
    setViewMode(newMode);
    localStorage.setItem("pref-rpViewMode", newMode);
  };

  // Global mouse events for RP sidebar splitter
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDraggingSidebar) {
        return;
      }
      const rarpLayout = document.querySelector(".rarp-layout");
      if (!rarpLayout) {
        return;
      }
      const containerLeft = rarpLayout.getBoundingClientRect().left;
      let newWidth = e.clientX - containerLeft;
      if (newWidth < 150) {
        newWidth = 150;
      }
      if (newWidth > window.innerWidth * 0.5) {
        newWidth = window.innerWidth * 0.5;
      }
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (isDraggingSidebar) {
        setIsDraggingSidebar(false);
      }
    };

    if (isDraggingSidebar) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
    } else {
      document.body.style.cursor = "default";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDraggingSidebar]);

  const reqToNav = useMemo(() => {
    const map = {};
    script.displayStrings.forEach((ds, dsIndex) => {
      map[ds.toRefString()] = { type: "display", index: dsIndex, macro: "Condition" };
      if (ds.condition) {
        ds.condition.groups.forEach((g) =>
          g.forEach((req) => {
            map[req.toRefString()] = { type: "display", index: dsIndex, macro: "Condition" };
          }),
        );
      }
      ds.parts.forEach((p) => {
        if (p.isMacro && p.logic) {
          p.logic.groups.forEach((g) =>
            g.forEach((req) => {
              map[req.toRefString()] = { type: "display", index: dsIndex, macro: p.text };
            }),
          );
        }
      });
    });
    script.scriptLookups.forEach((l) => {
      const isFormatter = l.entries.length === 0 && l.defaultVal === null;
      const type = isFormatter ? "formatter" : "lookup";

      const formatters = script.scriptLookups.filter(
        (x) => x.entries.length === 0 && x.defaultVal === null,
      );
      const lookups = script.scriptLookups.filter(
        (x) => x.entries.length > 0 || x.defaultVal !== null,
      );

      const typeIndex = isFormatter ? formatters.indexOf(l) : lookups.indexOf(l);
      map[l.toRefString()] = { type, index: typeIndex, macro: "Condition" };
    });
    return map;
  }, [script]);

  const { dsSeverities, lookupSeverities, formatterSeverities } = useMemo(() => {
    const dsSev = script.displayStrings.map(() => 0);
    const formatters = script.scriptLookups.filter(
      (x) => x.entries.length === 0 && x.defaultVal === null,
    );
    const lookups = script.scriptLookups.filter(
      (x) => x.entries.length > 0 || x.defaultVal !== null,
    );
    const lSev = lookups.map(() => 0);
    const fSev = formatters.map(() => 0);

    if (feedback && feedback.issues) {
      feedback.issues.forEach((group) =>
        group.forEach((issue) => {
          if (issue.target) {
            const nav = reqToNav[issue.target.toRefString()];
            if (nav) {
              if (nav.type === "display") {
                dsSev[nav.index] = Math.max(dsSev[nav.index], issue.severity);
              } else if (nav.type === "lookup") {
                lSev[nav.index] = Math.max(lSev[nav.index], issue.severity);
              } else if (nav.type === "formatter") {
                fSev[nav.index] = Math.max(fSev[nav.index], issue.severity);
              }
            }
          }
        }),
      );
    }
    return { dsSeverities: dsSev, lookupSeverities: lSev, formatterSeverities: fSev };
  }, [script, feedback, reqToNav]);

  const handleIssueClick = (issue) => {
    if (!issue.target) {
      return;
    }
    const reqRef = issue.target.toRefString();
    const nav = reqToNav[reqRef];

    if (nav) {
      const targetMacro = issue.macro || nav.macro || "Condition";
      if (viewMode === "rarp") {
        setSelectedItem({ type: nav.type, index: nav.index, macro: targetMacro });
        setTimeout(() => {
          document
            .querySelectorAll(".logic-table .selected, .rarp-main.selected")
            .forEach((e) => e.classList.remove("selected"));
          const el = document.getElementById(reqRef);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("selected");
          } else if (issue.target.parts) {
            // If it's a general Display String issue targeting the string itself
            const mainContainer = document.getElementById(reqRef);
            if (mainContainer) {
              mainContainer.classList.add("selected");
            }
          }
        }, 100);
      } else {
        document
          .querySelectorAll(".logic-table .selected, .rarp-main.selected")
          .forEach((e) => e.classList.remove("selected"));
        const el = document.getElementById(reqRef);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("selected");
        }
      }
    }
  };

  // Generate summary metrics
  const lookupCount = script.scriptLookups.filter(
    (l) => l.entries.length > 0 || l.defaultVal !== null,
  ).length;
  const formatterCount = script.scriptLookups.filter(
    (l) => l.entries.length === 0 && l.defaultVal === null,
  ).length;
  const dsCount = script.displayStrings.length;

  // Strict Check: It is only a valid default display if it's conditionless AND static (contains no macros)
  const defaultDs = script.displayStrings.some(
    (ds) => ds.isDefault && !ds.parts.some((p) => p.isMacro),
  )
    ? "Yes"
    : "No";

  return (
    <>
      <div className="main-header" style={{ marginBottom: "0", paddingBottom: "10px" }}>
        <div className="float-right" style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button onClick={toggleViewMode} type="button">
            {viewMode === "rarp" ? "Switch to Raw RP View" : "Switch to RP UI"}
          </button>
          <ConsoleIcon />
        </div>
        <SetBadge />
        <h1 id="asset-title" style={{ margin: "0 0 8px 0" }}>
          {get_game_title()}
        </h1>
        <div style={{ fontStyle: "italic", color: "#888", fontSize: "13px", lineHeight: "1.4" }}>
          <div>{lookupCount} Lookups</div>
          <div>{formatterCount} Formatters</div>
          <div>
            {dsCount} Display Strings (Default Display: {defaultDs})
          </div>
        </div>
        <div className="clear"></div>
      </div>

      <div className="fade-in-view" key={viewMode}>
        {viewMode === "rarp" ? (
          <div className="rarp-layout">
            <RARPTreeView
              dsSeverities={dsSeverities}
              formatterSeverities={formatterSeverities}
              lookupSeverities={lookupSeverities}
              script={script}
              selectedItem={selectedItem}
              setSelectedItem={setSelectedItem}
              sidebarWidth={sidebarWidth}
            />

            {/* Vertical Splitter */}
            <div
              className={`resizer-x ${isDraggingSidebar ? "active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setIsDraggingSidebar(true);
              }}
            ></div>

            <RARPDetailView
              isHex={isHex}
              script={script}
              selectedItem={selectedItem}
              setSelectedItem={setSelectedItem}
              toggleHex={toggleHex}
            />
          </div>
        ) : (
          <div style={{ marginTop: "20px" }}>
            <HighlightedRichPresence onLogicSelected={setLogicData} script={script.text} />
            <div className="data-table" style={{ marginTop: "20px" }}>
              {logicData && <LogicTable isHex={isHex} logic={logicData} toggleHex={toggleHex} />}
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: "20px" }}>
        <RPAssetFeedback issues={feedback.issues} onIssueClick={handleIssueClick} />
      </div>
    </>
  );
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // keeps the canvas exportable
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// Draws the classic badge board (same layout as upstream AutoCR) for copying as an image
async function renderBadgeCanvas(set, achs, authorText) {
  const PADDING = 10;
  const ROWLEN = 10;
  const WIDTH = 2 * PADDING + (64 + PADDING) * ROWLEN;
  const HEIGHT = PADDING + 96 + PADDING + (64 + PADDING) * Math.ceil(achs.length / ROWLEN);

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#2b374a";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "#111111";
  ctx.fillRect(PADDING + 3, PADDING + 3, 96, 96);

  const badgePos = (i) => [
    2 * PADDING + (i % ROWLEN) * (64 + PADDING),
    PADDING + 96 + PADDING + Math.floor(i / ROWLEN) * (64 + PADDING),
  ];
  for (let i = 0; i < achs.length; i++) {
    const [x, y] = badgePos(i);
    ctx.fillRect(x + 3, y + 3, 64, 64);
  }

  const dropShadow = (text, x, y, font, maxwidth = 10_000) => {
    ctx.font = font;
    ctx.fillStyle = "black";
    ctx.fillText(text, x + 2, y + 2, maxwidth);
    ctx.fillStyle = "white";
    ctx.fillText(text, x, y, maxwidth);
  };
  const textWidth = WIDTH - (PADDING * 3 + 96);
  ctx.textBaseline = "top";
  dropShadow(
    set.title || "Untitled",
    PADDING * 2 + 96 + 5,
    PADDING + 5,
    "bold 32px serif",
    textWidth,
  );
  dropShadow(authorText, PADDING * 2 + 96 + 10, PADDING + 48, "18px serif", textWidth);

  const consoleIcon = set.console?.icon
    ? `https://static.retroachievements.org/assets/images/system/${set.console.icon}.png`
    : null;
  if (consoleIcon) {
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    dropShadow(set.console.name, WIDTH - (3 * PADDING + 32), PADDING + 96 - 16, "12px serif");
  }

  const [icon, consoleImg, ...badges] = await Promise.all([
    set.icon ? loadImage(set.icon) : null,
    consoleIcon ? loadImage(consoleIcon) : null,
    ...achs.map((ach) => (ach.badge ? loadImage(ach.badge) : null)),
  ]);
  if (icon) {
    ctx.drawImage(icon, PADDING, PADDING, 96, 96);
  }
  if (consoleImg) {
    ctx.drawImage(consoleImg, WIDTH - 2 * PADDING - 32, PADDING + 96 - 32, 32, 32);
  }
  badges.forEach((img, i) => {
    if (img) {
      ctx.drawImage(img, ...badgePos(i), 64, 64);
    }
  });
  return canvas;
}

function CopyBadgeImageButton({ set, achs, authorText }) {
  const [status, setStatus] = useState("📋 Copy Image");
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    setBusy(true);
    setStatus("⏳ Rendering...");
    // passing a promise keeps the clipboard write tied to the click in Safari
    const blob = renderBadgeCanvas(set, achs, authorText).then(
      (canvas) =>
        new Promise((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("empty canvas"))), "image/png"),
        ),
    );
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setStatus("✅ Copied!");
    } catch (error) {
      // clipboard images are not available everywhere, so fall back to a download
      console.warn("Copy image failed, downloading instead:", error);
      try {
        const url = URL.createObjectURL(await blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${set.id ?? current.id}-badges.png`;
        a.click();
        URL.revokeObjectURL(url);
        setStatus("💾 Downloaded");
      } catch (error) {
        console.error("Rendering badge image failed:", error);
        setStatus("❌ Failed");
      }
    }
    setBusy(false);
    setTimeout(() => setStatus("📋 Copy Image"), 2000);
  };

  return (
    <button className="copy-badge-image" disabled={busy} onClick={copy} type="button">
      {status}
    </button>
  );
}

function BadgeGrid({ set = current.set }) {
  const achs = set.getAchievements();

  // Count and sort the set's authors
  const authorlist = achs.map((a) => a.author).filter(Boolean);
  const authcount = [],
    authors = new Set(authorlist);
  for (const auth of authors) {
    authcount.push([auth, authorlist.filter((x) => x === auth).length]);
  }
  authcount.sort(([, a], [, b]) => b - a); // most achievements first
  const authorText =
    authcount.length > 0 ? "Set developed by " + authcount.map(([a, _]) => a).join(", ") : "";

  return (
    <div className="classic-badge-board">
      <CopyBadgeImageButton achs={achs} authorText={authorText} set={set} />
      <div className="classic-badge-header">
        <img alt="Game Icon" className="game-icon" src={set.icon} />

        <div className="title-area">
          <h1>{set.title || "Untitled"}</h1>
          <p>{authorText}</p>
        </div>

        {set.console && (
          <div className="console-area">
            <span>{set.console.name}</span>
            {set.console.icon && (
              <img
                alt={set.console.name}
                height="32"
                src={`https://static.retroachievements.org/assets/images/system/${set.console.icon}.png`}
                width="32"
              />
            )}
          </div>
        )}
      </div>

      <div className="classic-badge-grid">
        {achs.map((ach) => (
          <div
            className="badge-item"
            key={ach.id}
            onClick={() => jump_to_asset(ach)}
            title={`🏆 ${ach.title} (${ach.points})\n${ach.desc}`}
          >
            <img
              alt={ach.title}
              src={ach.badge ? ach.badge : "https://media.retroachievements.org/Images/000001.png"}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function SetOverviewTab() {
  if (current.set == null) {
    return null;
  }
  const warn = SEVERITY_TO_CLASS[current.set.feedback.status()];
  return (
    <tr
      className={`asset-row ${warn}`}
      data-route=""
      id="asset-set-overview"
      onClick={(e) => show_overview(e, <AchievementSetOverview />)}
    >
      <td className="asset-name">🗺️ Set Overview</td>
    </tr>
  );
}

function CodeReviewTab() {
  if (current.set == null) {
    return null;
  }
  return (
    <tr
      className={`asset-row`}
      data-route="/review"
      id="asset-code-review"
      onClick={(e) => show_overview(e, <CodeReviewOverview />)}
    >
      <td className="asset-name">🔍 Detailed Set Breakdown</td>
    </tr>
  );
}

function CodeNotesTab() {
  if (current.notes.length === 0) {
    return null;
  }
  const warn = SEVERITY_TO_CLASS[current.notes.feedback.status()];
  return (
    <tr
      className={`asset-row ${warn}`}
      data-route="/notes"
      id="asset-code-notes"
      onClick={(e) => show_overview(e, <CodeNotesOverview />)}
    >
      <td className="asset-name">📝 Code Notes</td>
    </tr>
  );
}

function RichPresenceTab() {
  if (!current.rp || current.rp.displayStrings.length === 0) {
    return null;
  }
  const warn = SEVERITY_TO_CLASS[current.rp.feedback.status()];
  return (
    <tr
      className={`asset-row ${warn}`}
      data-route="/richp"
      id="asset-rich-presence"
      onClick={(e) => show_overview(e, <RichPresenceOverview />)}
    >
      <td className="asset-name">🎮 Rich Presence</td>
    </tr>
  );
}

function AchievementTabs({ matches = () => true }) {
  let achievements = current.set.getAchievements();
  let archived = current.set.getArchivedAchievements();
  const [showArchived, setShowArchived] = useState(false);

  if (achievements.length === 0 && archived.length === 0) {
    return null;
  }

  // preload all images
  new Image().src = current.set.icon;
  for (const ach of [...achievements, ...archived]) {
    new Image().src = ach.badge;
  }

  achievements = achievements.sort((a, b) => a.state.rank - b.state.rank);
  archived = archived.sort((a, b) => a.state.rank - b.state.rank);
  const shownAchievements = achievements.filter(matches);
  const shownArchived = archived.filter(matches);

  return (
    <>
      <tr className="asset-header">
        <td>
          Achievements
          <ReviewProgress assets={achievements} />
        </td>
      </tr>
      {shownAchievements.map((ach) => {
        const warn = SEVERITY_TO_CLASS[ach.feedback.status()];
        return (
          <tr
            className={`asset-row ${warn}`}
            data-route={`/achievement/${ach.id}`}
            id={ach.toRefString()}
            key={`a${ach.id}`}
            onClick={(e) => show_overview(e, <AchievementInfo ach={ach} />)}
          >
            <td className="asset-name">
              {get_review(ach).done ? "✅" : "🏆"} {ach.state.marker}
              {ach.title} ({ach.points})
            </td>
          </tr>
        );
      })}

      {/* Bloco da Sanfona para Conquistas Arquivadas */}
      {shownArchived.length > 0 && (
        <>
          <tr
            className="asset-header"
            onClick={() => setShowArchived(!showArchived)}
            style={{ cursor: "pointer", userSelect: "none" }}
          >
            <td>
              {showArchived ? "▼" : "▶"} Archived ({shownArchived.length})
            </td>
          </tr>

          {showArchived &&
            shownArchived.map((ach) => {
              const warn = SEVERITY_TO_CLASS[ach.feedback.status()];
              // Adiciona a classe 'fade' para escurecer as conquistas arquivadas
              return (
                <tr
                  className={`asset-row ${warn} fade`}
                  data-route={`/achievement/${ach.id}`}
                  id={ach.toRefString()}
                  key={`a${ach.id}`}
                  onClick={(e) => show_overview(e, <AchievementInfo ach={ach} />)}
                >
                  <td className="asset-name">
                    {get_review(ach).done ? "✅" : "🏆"} {ach.state.marker}
                    {ach.title} ({ach.points})
                  </td>
                </tr>
              );
            })}
        </>
      )}
    </>
  );
}

function LeaderboardTabs({ matches = () => true }) {
  let leaderboards = current.set.getLeaderboards();
  if (leaderboards.length === 0) {
    return null;
  }

  leaderboards = leaderboards.sort((a, b) => a.state.rank - b.state.rank);
  const shownLeaderboards = leaderboards.filter(matches);
  return (
    <>
      <tr className="asset-header">
        <td>
          Leaderboards
          <ReviewProgress assets={leaderboards} />
        </td>
      </tr>
      {shownLeaderboards.map((lb) => {
        const warn = SEVERITY_TO_CLASS[lb.feedback.status()];
        return (
          <tr
            className={`asset-row ${warn}`}
            data-route={`/leaderboard/${lb.id}`}
            id={lb.toRefString()}
            key={`b${lb.id}`}
            onClick={(e) => show_overview(e, <LeaderboardInfo lb={lb} />)}
          >
            <td className="asset-name">
              {get_review(lb).done ? "✅" : "📊"} {lb.state.marker}
              {lb.title}
            </td>
          </tr>
        );
      })}
    </>
  );
}

const ASSET_FILTERS = {
  all: { label: "All assets", test: () => true },
  issues: {
    label: "With warnings",
    test: (a) => a.feedback?.status() >= FeedbackSeverity.WARN,
  },
  errors: {
    label: "With errors",
    test: (a) => a.feedback?.status() >= FeedbackSeverity.FAIL,
  },
  local: { label: "Local", test: (a) => a.state === AssetState.LOCAL },
  modified: { label: "Changed locally", test: (a) => a.changes().length > 0 },
  unreviewed: { label: "Not reviewed", test: (a) => !get_review(a).done },
};

// Keeps its own state so typing doesn't re-run SidebarTabs' route effect
function FilteredAssetTabs() {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");

  const needle = query.trim().toLowerCase();
  const matches = (asset) =>
    ASSET_FILTERS[kind].test(asset) &&
    (!needle || `${asset.title} ${asset.desc} ${asset.id}`.toLowerCase().includes(needle));

  if (current.set.getAchievements().length + current.set.getLeaderboards().length === 0) {
    return null;
  }
  return (
    <>
      <tr className="asset-filter">
        <td>
          <input
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => e.stopPropagation()} // keep arrow keys for the text box
            placeholder="Search assets…"
            type="search"
            value={query}
          />
          <select
            onChange={(e) => setKind(e.currentTarget.value)}
            onKeyDown={(e) => e.stopPropagation()}
            value={kind}
          >
            {Object.entries(ASSET_FILTERS).map(([key, { label }]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </td>
      </tr>
      <AchievementTabs matches={matches} />
      <LeaderboardTabs matches={matches} />
    </>
  );
}

function SidebarTabs() {
  // oxlint-disable-next-line @nkzw/require-use-effect-arguments
  useEffect(route_change);

  return (
    <>
      <SetOverviewTab />
      <CodeNotesTab />
      <RichPresenceTab />
      <CodeReviewTab />
      <FilteredAssetTabs />
    </>
  );
}

function show_overview(e, node) {
  container.render(
    <Fragment>
      <GlobalTooltip />
      {node}
    </Fragment>,
  );
  selectTab(e.currentTarget);

  const route = e.currentTarget.getAttribute("data-route");
  history.pushState({}, "", `#!/game/${current.id}${route}`);
}

function update() {
  // assess all code notes
  current.notes.sort((a, b) => a.addr - b.addr);
  assess_code_notes(current.notes);

  current.notes.audit = Auditor.auditNotes(current.notes);
  const qaIssues = current.notes.audit.map(({ note, issues: report, fix: suggestedFix }) => ({
    target: note,
    severity: report.some((issue) => issue.level === "ERROR") ? 3 : 2,
    type: {
      desc: `[AUTOCR] ${toDisplayHex(note.addr)} — ${report.length} error(s)`,
      ref: ["https://docs.retroachievements.org/guidelines/content/code-notes.html"],
    },
    detail: (
      <details id={`qa-issue-${note.addr}`} style={{ marginTop: "10px" }}>
        <summary
          style={{ cursor: "pointer", fontWeight: "bold", padding: "4px 0", outline: "none" }}
        >
          Expand details and suggested correction
        </summary>

        <div
          style={{
            marginTop: "10px",
            paddingLeft: "12px",
            borderLeft: "2px solid rgba(255,255,255,0.1)",
          }}
        >
          <strong>Original Note:</strong>
          <pre
            style={{
              background: "rgba(0,0,0,0.1)",
              padding: "8px",
              borderLeft: "3px solid #ff4444",
              whiteSpace: "pre-wrap",
              marginTop: "6px",
            }}
          >
            {note.note}
          </pre>

          <ul style={{ listStyleType: "none", paddingLeft: 0, margin: "12px 0" }}>
            {report.map((issue, idx) => (
              <li key={idx} style={{ marginBottom: "6px" }}>
                <strong>[{idx + 1}]</strong> {issue.level === "ERROR" ? "Error:" : "Warning:"}{" "}
                {issue.message}
              </li>
            ))}
          </ul>

          <strong>Suggested correction:</strong>
          <pre
            style={{
              background: "rgba(0,0,0,0.1)",
              padding: "8px",
              borderLeft: "3px solid #44ff44",
              color: "#ccc",
              whiteSpace: "pre-wrap",
              marginTop: "6px",
            }}
          >
            {suggestedFix}
          </pre>
        </div>
      </details>
    ),
  }));

  if (qaIssues.length > 0) {
    qaIssues.label = "Code Notes";
    current.notes.feedback.issues.push(qaIssues);
  }

  // ensure that every achievement and leaderboard has been assessed
  // don't assume they have already been processed, as code notes might be new
  for (const ach of [...current.set.getAchievements(), ...current.set.getArchivedAchievements()]) {
    assess_achievement(ach);
  }
  for (const lb of current.set.getLeaderboards()) {
    assess_leaderboard(lb);
  }

  // assess rich presence
  assess_rich_presence(current.rp);

  // set assessment relies on other assessments for some stats
  assess_set(current.set);

  // re-render the sidebar with any newly-loaded assets
  sidebar.render(<SidebarTabs />);
  load_reviews();
  document.title = "[AutoCR] " + (get_game_title() ?? "");
}

function load_achievement_set(json) {
  current.set.addJSON(json);
  if (json.RichPresencePatch) {
    load_rich_presence(json.RichPresencePatch, false);
  }
  update();
}

function load_user_file(txt) {
  current.set.addLocal(txt, current.notes);
  update();
}

function load_code_notes(json) {
  for (const obj of json) {
    if (obj.Note) {
      current.notes.add(new CodeNote(obj.Address, obj.Note, obj.User));
    }
  }
  update();
}

function load_rich_presence(txt, from_file) {
  if (!current.rp || from_file) {
    current.rp = RichPresence.fromText(txt);
  }
  update();
}

function route_change() {
  const parts = location.hash.toLowerCase().split("/");
  switch (
    parts[3] ??
    "" // choose a route
  ) {
    case "ach":
    case "achievement":
      jump_to_asset(current.set.achievements.get(+parts[4]));
      break;
    case "lb":
    case "leaderboard":
      jump_to_asset(current.set.leaderboards.get(+parts[4]));
      break;
    case "notes":
    case "codenotes":
    case "code-notes":
    case "memory":
      document.getElementById("asset-code-notes")?.click();
      break;
    case "richp":
    case "richpresence":
    case "rich-presence":
    case "rp":
      document.getElementById("asset-rich-presence")?.click();
      break;
    case "review":
      document.getElementById("asset-code-review")?.click();
      break;
    default:
      document.querySelectorAll("#list-body .asset-row")?.[0]?.click();
  }
}

function main(event) {
  if (location.hash.startsWith("#!/")) {
    const parts = location.hash.toLowerCase().split("/");
    switch (parts[1]) {
      case "game": {
        if (Number(parts[2]) === current.id) {
          return route_change();
        }

        const fresh = skip_saved_session;
        skip_saved_session = false;
        (fresh ? Promise.resolve(null) : loadSession()).then((session) => {
          if (session?.id === Number(parts[2]) && session.files?.length) {
            restore_session(session);
          } else {
            load_from_middleware(parts[2]);
          }
        });
        return;
      }
    }
  }
  show_saved_session();
}

function load_from_middleware(gameid) {
  reset_loaded();
  document.getElementById("loading-overlay").classList.add("shown");
  fetch(`${MIDDLEWARE_URL}/pack/${gameid}`)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      current.id = data.game?.GameId;
      current.set.addJSON(data.game);
      if (data.game.RichPresencePatch) {
        load_rich_presence(data.game.RichPresencePatch, false);
      }
      for (const obj of data.notes) {
        if (obj.Note) {
          current.notes.add(new CodeNote(obj.Address, obj.Note, obj.User));
        }
      }
      update();
    })
    .catch((error) => {
      console.error("Error fetching data:", error);
    })
    .finally(() => {
      document.getElementById("loading-overlay").classList.remove("shown");
    });
}

// --------------------------------------------------
// EXPLAINER UI COMPONENTS
// --------------------------------------------------

// Helper to wrap specific phrases in colored spans
const highlightKeywords = (text) => {
  if (!text) {
    return null;
  }

  // Regex explanations:
  // 1. (reset|pause|lock) the achievement : Long phrases are safe
  // 2. (MeasuredIf) : Distinct flag name
  // 3. \b(Measured|Measured%)\b : Strict word boundary
  // 4. \bTrigger\b : Strict word boundary
  // 5. \bActivate\b : Strict word boundary for Transition logic
  // 6. \[.*?\] : Variables/Code Notes inside brackets
  // 7. \".*?\" : Quoted Strings (Enums)
  const regex =
    /(reset the achievement|pause the achievement|lock the achievement|MeasuredIf|\bMeasured%?\b|\bTrigger\b|\bActivate\b|\[.*?\]|".*?")/g;

  const parts = text.split(regex);

  return parts.map((part, i) => {
    const lower = part.toLowerCase();

    // 1. Variable Highlighting (Remove Brackets + Truncate)
    // We detect [Variables] and strip the brackets for display
    if (part.startsWith("[") && part.endsWith("]")) {
      const content = part.slice(1, -1);
      // Use title for tooltip (full content) in case CSS truncates it
      return (
        <span className="logic-variable" key={i} title={content}>
          {content}
        </span>
      );
    }

    // 2. Enum Highlighting (Remove Quotes & Italicize)
    if (part.startsWith('"') && part.endsWith('"')) {
      // oxlint-disable-next-line unicorn/prefer-string-slice
      const content = part.substring(1, part.length - 1);
      // Check if it's just empty quotes
      if (!content) {
        return part;
      }
      return (
        <em className="logic-enum" key={i}>
          {content}
        </em>
      );
    }

    if (lower === "reset the achievement") {
      return (
        <span className="logic-keyword-reset" key={i}>
          {part}
        </span>
      );
    }
    if (lower === "pause the achievement" || lower === "lock the achievement") {
      return (
        <span className="logic-keyword-pause" key={i}>
          {part}
        </span>
      );
    }
    if (part === "MeasuredIf") {
      return (
        <span className="logic-keyword-measuredif" key={i}>
          {part}
        </span>
      );
    }
    if (part === "Measured" || part === "Measured%") {
      return (
        <span className="logic-keyword-measured" key={i}>
          {part}
        </span>
      );
    }

    if (part === "Trigger") {
      const nextPart = parts[i + 1];
      if (nextPart && (nextPart.startsWith(" when") || nextPart.startsWith(" Indicator"))) {
        return (
          <span className="logic-keyword-trigger" key={i}>
            {part}
          </span>
        );
      }
      return part;
    }

    if (part === "Activate") {
      return (
        <span className="logic-keyword-activate" key={i}>
          {part}
        </span>
      );
    }

    return part;
  });
};

function LogicExplanation({ asset, groups, showDecimal = true }) {
  try {
    const { mainText, detailedInfo } = LogicExplainer.explainAsset(
      asset,
      groups,
      current.notes,
      null,
      showDecimal, // Pass the prop to the explainer logic.
    );

    // Recursive parser to handle nested [[EXPAND]] tokens
    const parseContentRecursively = (text, uniqueKeyPrefix) => {
      if (!text) {
        return null;
      }

      // 1. Split by EXPAND tokens first
      const parts = text.split(/(\[\[EXPAND:.*?:.*?\]\])/g);

      return parts.map((part, index) => {
        const match = part.match(/^\[\[EXPAND:(.*?):(.*?)\]\]$/);
        if (match) {
          const id = match[1];
          const label = match[2];
          const rawDetailText = detailedInfo[id] || "No details found.";

          return (
            <details
              className="explainer-details"
              key={`${uniqueKeyPrefix}-${index}`}
              style={{ display: "inline-block", verticalAlign: "top", margin: "2px" }}
            >
              <summary>{label}</summary>
              <div style={{ marginTop: "5px", whiteSpace: "pre-wrap" }}>
                {/* Recursively parse the inner detail text for nested structures */}
                {parseContentRecursively(rawDetailText, `${uniqueKeyPrefix}-${index}-inner`)}
              </div>
            </details>
          );
        }

        // 2. Process text for keywords and variables
        return <Fragment key={`${uniqueKeyPrefix}-${index}`}>{highlightKeywords(part)}</Fragment>;
      });
    };

    const renderLines = () => {
      const lines = mainText.split("\n");
      const elements = [];

      let listBuffer = [];

      const flushList = () => {
        if (listBuffer.length > 0) {
          const isFirst = elements.length === 0;
          const style = isFirst ? { marginTop: 0 } : undefined;
          elements.push(
            <ul key={`ul-${elements.length}`} style={style}>
              {listBuffer}
            </ul>,
          );
          listBuffer = [];
        }
      };

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trimEnd();

        if (line.trim() === "") {
          flushList();
          continue;
        }

        // Determine if this is the very first element to remove top margin
        const isFirst = elements.length === 0 && listBuffer.length === 0;
        const style = isFirst ? { marginTop: 0 } : undefined;

        // Markdown Headers
        if (line.startsWith("# ")) {
          flushList();
          // Parse content recursively in headers to support [[EXPAND]]
          elements.push(
            <h1 key={i} style={style}>
              {parseContentRecursively(line.slice(2), `h1-${i}`)}
            </h1>,
          );
        } else if (line.startsWith("## ")) {
          flushList();
          // Parse content recursively in headers to support [[EXPAND]]
          elements.push(
            <h2 key={i} style={style}>
              {parseContentRecursively(line.slice(3), `h2-${i}`)}
            </h2>,
          );
        } else if (line.startsWith("### ")) {
          flushList();
          // Parse content recursively in headers to support [[EXPAND]]
          elements.push(
            <h3 key={i} style={style}>
              {parseContentRecursively(line.slice(4), `h3-${i}`)}
            </h3>,
          );
        }
        // List Items
        else if (line.startsWith("- ")) {
          // Use recursive parser for list items
          listBuffer.push(<li key={i}>{parseContentRecursively(line.slice(2), `li-${i}`)}</li>);
        }
        // Top-level block expanders (like Array Logic Details)
        else if (line.startsWith("[[EXPAND:")) {
          flushList();
          elements.push(
            <div key={i} style={style}>
              {parseContentRecursively(line, `block-${i}`)}
            </div>,
          );
        }
        // Standard Paragraphs
        else {
          flushList();
          elements.push(
            <p key={i} style={style}>
              {parseContentRecursively(line, `p-${i}`)}
            </p>,
          );
        }
      }
      flushList();
      return elements;
    };

    // oxlint-disable-next-line react/error-boundaries
    return <div className="logic-explanation">{renderLines()}</div>;
  } catch (error) {
    console.error(error);
    return (
      <div
        className="logic-explanation"
        style={{ color: "red", border: "1px solid red", padding: "10px" }}
      >
        <h3>⚠️ Explainer Error</h3>
        <p>An error occurred while generating the explanation:</p>
        <pre>{error.message}</pre>
        <pre>{error.stack}</pre>
      </div>
    );
  }
}

let _testIndex = 0;
// oxlint-disable-next-line no-unused-vars
function testAchievement(mem) {
  _testIndex += 1;
  const id = 9_000_000 + _testIndex;
  current.set.achievements.set(
    id,
    Achievement.fromJSON({
      ID: id,
      Title: `Test Achievement #${_testIndex}`,
      Description: `Test Achievement #${_testIndex}`,
      Points: 0,
      Author: "Test User",
      Type: "",
      Flags: 5,
      MemAddr: mem,
    }),
  );
  update();
}

reset_loaded();
main();
window.onhashchange = main;

// --- AutoCR Side Panel Toggle Feature & Main Layout Splitter ---
(function initAutoCRSidebarLayout() {
  // 1. Inject Transition CSS
  if (!document.getElementById("autocr-dynamic-slide-css")) {
    const style = document.createElement("style");
    style.id = "autocr-dynamic-slide-css";
    style.innerHTML = `
			#asset-list {
				transition: flex-basis 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.3s cubic-bezier(0.4, 0, 0.2, 1), min-width 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease, padding 0.3s ease;
			}
			/* When disabled via JS during drag, removing the class removes the transition */
			#asset-list.no-transition {
				transition: none !important;
			}
			body.autocr-sidebar-hidden #asset-list {
				flex-basis: 0 !important;
				width: 0 !important;
				min-width: 0 !important;
				padding-left: 0 !important;
				padding-right: 0 !important;
				border: none !important;
				opacity: 0 !important;
			}
			body.autocr-sidebar-hidden #main-splitter {
				display: none !important;
			}
			/* Keep hidden until animation completes */
			body.autocr-sidebar-fully-hidden #autocr-restore-btn {
				display: block !important;
			}
		`;
    document.head.append(style);
  }

  // 2. Create the Splitter between asset-list and asset-info
  const assetList = document.getElementById("asset-list");
  const assetInfo = document.getElementById("asset-info");

  if (assetList && assetInfo && !document.getElementById("main-splitter")) {
    const splitter = document.createElement("div");
    splitter.id = "main-splitter";
    splitter.className = "resizer-x";

    // Insert between sidebar and main info
    assetList.parentNode.insertBefore(splitter, assetInfo);

    let isDragging = false;
    splitter.addEventListener("mousedown", (e) => {
      isDragging = true;
      assetList.classList.add("no-transition"); // prevent sluggish dragging
      splitter.classList.add("active");
      document.body.style.cursor = "col-resize";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) {
        return;
      }
      let newWidth = e.clientX;
      if (newWidth < 200) {
        newWidth = 200;
      } // minimum width
      if (newWidth > window.innerWidth * 0.8) {
        newWidth = window.innerWidth * 0.8;
      } // max width

      // Force absolute width everywhere so the internal table natively expands
      assetList.style.flexBasis = newWidth + "px";
      assetList.style.width = newWidth + "px";
      assetList.style.minWidth = newWidth + "px";
      assetList.style.maxWidth = "none";
    });

    document.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        assetList.classList.remove("no-transition");
        splitter.classList.remove("active");
        document.body.style.cursor = "default";
      }
    });
  }

  // 3. Create the persistent Restore Button (Hidden when sidebar is active)
  if (!document.getElementById("autocr-restore-btn")) {
    const restoreBtn = document.createElement("button");
    restoreBtn.id = "autocr-restore-btn";
    restoreBtn.innerHTML = "&#x25B6;"; // ▶
    restoreBtn.title = "Show AutoCR Side Panel";
    restoreBtn.style.position = "fixed";
    restoreBtn.style.bottom = "11px";
    restoreBtn.style.left = "10px";
    restoreBtn.style.zIndex = "99999";
    restoreBtn.style.display = "none"; // CSS toggles this
    restoreBtn.style.padding = "6px 12px"; // Squarish to match the screenshot footprint

    restoreBtn.addEventListener("click", () => {
      document.body.classList.remove("autocr-sidebar-fully-hidden", "autocr-sidebar-hidden");
    });
    document.body.append(restoreBtn);
  }

  // 4. Reliable loop to inject the Collapse button into the Sidebar footer next to Unload
  setInterval(() => {
    const footerTd = document.querySelector("#list-foot td");

    if (footerTd && !footerTd.querySelector(".autocr-collapse-btn")) {
      const collapseBtn = document.createElement("button");
      collapseBtn.innerHTML = "&#x25C0;"; // ◀
      collapseBtn.title = "Hide Side Panel";
      collapseBtn.className = "autocr-collapse-btn";
      collapseBtn.style.padding = "6px 12px";
      collapseBtn.style.marginRight = "5px"; // Separate it slightly from "Unload Set"

      collapseBtn.addEventListener("click", () => {
        document.body.classList.add("autocr-sidebar-hidden");
        setTimeout(() => {
          // Only add fully-hidden class if it hasn't been un-hidden in the meantime
          if (document.body.classList.contains("autocr-sidebar-hidden")) {
            document.body.classList.add("autocr-sidebar-fully-hidden");
          }
        }, 300); // 300ms matches the CSS transition duration
      });

      // Insert BEFORE the Unload Set button
      footerTd.insertBefore(collapseBtn, footerTd.firstChild);
    }
  }, 500);
})();
