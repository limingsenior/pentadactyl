// Copyright (c) 2006-2008 by Martin Stubenschrott <stubenschrott@vimperator.org>
// Copyright (c) 2007-2009 by Doug Kearns <dougkearns@gmail.com>
// Copyright (c) 2008-2010 by Kris Maglione <maglione.k@gmail.com>
//
// This work is licensed for reuse under an MIT license. Details are
// given in the LICENSE.txt file included with this file.
"use strict";

/** @scope modules */

/**
 * This class is used for prompting of user input and echoing of messages.
 *
 * It consists of a prompt and command field be sure to only create objects of
 * this class when the chrome is ready.
 */
const CommandLine = Module("commandline", {
    init: function () {
        const self = this;

        this._callbacks = {};

        storage.newArray("history-search", { store: true, privateData: true });
        storage.newArray("history-command", { store: true, privateData: true });

        this._messageHistory = { //{{{
            _messages: [],
            get messages() {
                let max = options["messages"];

                // resize if 'messages' has changed
                if (this._messages.length > max)
                    this._messages = this._messages.splice(this._messages.length - max);

                return this._messages;
            },

            get length() this._messages.length,

            clear: function clear() {
                this._messages = [];
            },

            filter: function filter(fn, self) {
                this._messages = this._messages.filter(fn, self);
            },

            add: function add(message) {
                if (!message)
                    return;

                if (this._messages.length >= options["messages"])
                    this._messages.shift();

                this._messages.push(update({
                    timestamp: Date.now()
                }, message));
            }
        }; //}}}

        this._lastMowOutput = null;

        this._silent = false;
        this._quiet = false;
        this._keepCommand = false;
        this._lastEcho = null;

        /////////////////////////////////////////////////////////////////////////////}}}
        ////////////////////// TIMERS //////////////////////////////////////////////////
        /////////////////////////////////////////////////////////////////////////////{{{

        this._statusTimer = Timer(5, 100, function statusTell() {
            if (self._completions == null)
                return;
            if (self._completions.selected == null)
                statusline.updateProgress("");
            else
                statusline.updateProgress("match " + (self._completions.selected + 1) + " of " + self._completions.items.length);
        });

        this._autocompleteTimer = Timer(200, 500, function autocompleteTell(tabPressed) {
            dactyl.trapErrors(function () {
                if (!events.feedingKeys && self._completions && options.get("autocomplete").values.length) {
                    self._completions.complete(true, false);
                    if (self._completions)
                        self._completions.itemList.show();
                }
            });
        });

        // This timer just prevents <Tab>s from queueing up when the
        // system is under load (and, thus, giving us several minutes of
        // the completion list scrolling). Multiple <Tab> presses are
        // still processed normally, as the timer is flushed on "keyup".
        this._tabTimer = Timer(0, 0, function tabTell(event) {
            dactyl.trapErrors(function () {
                if (self._completions)
                    self._completions.tab(event.shiftKey);
            });
        });

        /////////////////////////////////////////////////////////////////////////////}}}
        ////////////////////// VARIABLES ///////////////////////////////////////////////
        /////////////////////////////////////////////////////////////////////////////{{{

        memoize(this, "_completionList", function () ItemList("dactyl-completions"));
        this._completions = null;
        this._history = null;

        this._startHints = false; // whether we're waiting to start hints mode
        this._lastSubstring = "";

        memoize(this, "widgets", function () {
            let widgets = {
                commandline: document.getElementById("dactyl-commandline"),
                prompt: document.getElementById("dactyl-commandline-prompt"),
                command: document.getElementById("dactyl-commandline-command"),

                message: document.getElementById("dactyl-message"),

                multilineOutput: document.getElementById("dactyl-multiline-output"),
                multilineInput: document.getElementById("dactyl-multiline-input"),
            };

            widgets.command.inputField.QueryInterface(Ci.nsIDOMNSEditableElement);
            widgets.message.inputField.QueryInterface(Ci.nsIDOMNSEditableElement);
            widgets.mowContainer = widgets.multilineOutput.parentNode;

            widgets.multilineOutput.contentDocument.body.id = "dactyl-multiline-output-content";
            return widgets;
        });

        // we need to save the mode which were in before opening the command line
        // this is then used if we focus the command line again without the "official"
        // way of calling "open"
        this._currentExtendedMode = null;     // the extended mode which we last openend the command line for
        this._currentPrompt = null;
        this._currentCommand = null;

        // save the arguments for the inputMultiline method which are needed in the event handler
        this._multilineRegexp = null;
        this._multilineCallback = null;

        this._input = {};

        this.registerCallback("submit", modes.EX, function (command) {
            commands.repeat = command;
            dactyl.execute(command);
        });
        this.registerCallback("complete", modes.EX, function (context) {
            context.fork("ex", 0, completion, "ex");
        });
        this.registerCallback("change", modes.EX, function (command) {
            self._autocompleteTimer.tell(false);
        });

        this.registerCallback("cancel", modes.PROMPT, cancelPrompt);
        this.registerCallback("submit", modes.PROMPT, closePrompt);
        this.registerCallback("change", modes.PROMPT, function (str) {
            if (self._input.complete)
                self._autocompleteTimer.tell(false);
            if (self._input.change)
                self._input.change.call(commandline, str);
        });
        this.registerCallback("complete", modes.PROMPT, function (context) {
            if (self._input.complete)
                context.fork("input", 0, commandline, self._input.complete);
        });

        function cancelPrompt(value) {
            let callback = self._input.cancel;
            self._input = {};
            if (callback)
                callback.call(self, value != null ? value : commandline.command);
        }

        function closePrompt(value) {
            let callback = self._input.submit;
            self._input = {};
            if (callback)
                callback.call(self, value != null ? value : commandline.command);
        }
    },


    /**
     * Highlight the messageBox according to <b>group</b>.
     */
    set highlightGroup(group) {
        highlight.highlightNode(this.widgets.message, group);
    },
    get highlightGroup() this.widgets.message.getAttributeNS(NS.uri, "highlight"),

    /**
     * Determines whether the command line should be visible.
     *
     * @returns {boolean}
     */
    get commandVisible() modes.main == modes.COMMAND_LINE &&
            !(modes.extended & (modes.INPUT_MULTILINE | modes.OUTPUT_MULTILINE)),

    /**
     * Set the command-line prompt.
     *
     * @param {string} val
     * @param {string} highlightGroup
     */
    _setPrompt: function (val, highlightGroup) {
        this.widgets.prompt.value = val;
        this.widgets.prompt.size = val.length;
        this.widgets.prompt.collapsed = (val == "");
        highlight.highlightNode(this.widgets.prompt, highlightGroup || commandline.HL_NORMAL);
    },

    /**
     * Set the command-line input value. The caret is reset to the
     * end of the line.
     *
     * @param {string} cmd
     */
    _setCommand: function (cmd) {
        this.widgets.command.value = cmd;
        this.widgets.command.selectionStart = cmd.length;
        this.widgets.command.selectionEnd = cmd.length;
    },

    /**
     * Display a message in the command-line area.
     *
     * @param {string} str
     * @param {string} highlightGroup
     * @param {boolean} forceSingle If provided, don't let over-long
     *     messages move to the MOW.
     */
    _echoLine: function echoLine(str, highlightGroup, forceSingle) {
        this.highlightGroup = highlightGroup;
        this.widgets.message.value = str;

        dactyl.triggerObserver("echoLine", str, highlightGroup, forceSingle);

        if (!this.commandVisible)
            commandline.hide();

        let field = this.widgets.message.inputField;
        if (!forceSingle && field.editor.rootElement.scrollWidth > field.scrollWidth)
            this._echoMultiline(<span highlight="Message">{str}</span>, highlightGroup);
    },

    /**
     * Display a multiline message.
     *
     * @param {string} str
     * @param {string} highlightGroup
     */
    // TODO: resize upon a window resize
    _echoMultiline: function echoMultiline(str, highlightGroup) {
        let doc = this.widgets.multilineOutput.contentDocument;
        let win = this.widgets.multilineOutput.contentWindow;

        dactyl.triggerObserver("echoMultiline", str, highlightGroup);

        // If it's already XML, assume it knows what it's doing.
        // Otherwise, white space is significant.
        // The problem elsewhere is that E4X tends to insert new lines
        // after interpolated data.
        XML.ignoreWhitespace = false;
        XML.prettyPrinting = false;
        let style = typeof str === "string" ? "pre" : "nowrap";
        this._lastMowOutput = <div class="ex-command-output" style={"white-space: " + style} highlight={highlightGroup}>{str}</div>;
        let output = util.xmlToDom(this._lastMowOutput, doc);

        // FIXME: need to make sure an open MOW is closed when commands
        //        that don't generate output are executed
        if (this.widgets.mowContainer.collapsed)
            doc.body.innerHTML = "";

        doc.body.appendChild(output);

        commandline.updateOutputHeight(true);

        if (options["more"] && win.scrollMaxY > 0) {
            // start the last executed command's output at the top of the screen
            let elements = doc.getElementsByClassName("ex-command-output");
            elements[elements.length - 1].scrollIntoView(true);
        }
        else
            win.scrollTo(0, doc.height);

        win.focus();

        this._startHints = false;
        modes.set(modes.COMMAND_LINE, modes.OUTPUT_MULTILINE);
        commandline.updateMorePrompt();
    },

    /**
     * Ensure that the multiline input widget is the correct size.
     */
    _autosizeMultilineInputWidget: function () {
        let lines = this.widgets.multilineInput.value.split("\n").length - 1;

        this.widgets.multilineInput.setAttribute("rows", Math.max(lines, 1));
    },

    HL_NORMAL:     "Normal",
    HL_ERRORMSG:   "ErrorMsg",
    HL_MODEMSG:    "ModeMsg",
    HL_MOREMSG:    "MoreMsg",
    HL_QUESTION:   "Question",
    HL_INFOMSG:    "InfoMsg",
    HL_WARNINGMSG: "WarningMsg",
    HL_LINENR:     "LineNr",

    FORCE_MULTILINE    : 1 << 0,
    FORCE_SINGLELINE   : 1 << 1,
    DISALLOW_MULTILINE : 1 << 2, // If an echo() should try to use the single line
                                 // but output nothing when the MOW is open; when also
                                 // FORCE_MULTILINE is given, FORCE_MULTILINE takes precedence
    APPEND_TO_MESSAGES : 1 << 3, // Add the string to the message this._history.
    ACTIVE_WINDOW      : 1 << 4, // Only echo in active window.

    get completionContext() this._completions.context,

    get mode() (modes.extended == modes.EX) ? "cmd" : "search",

    get silent() this._silent,
    set silent(val) {
        this._silent = val;
        this._quiet = this._quiet;
    },
    get quiet() this._quiet,
    set quiet(val) {
        this._quiet = val;
        Array.forEach(this.widgets.commandline.childNodes, function (node) {
            node.style.opacity = this._quiet || this._silent ? "0" : "";
        }, this);
    },

    // @param type can be:
    //  "submit": when the user pressed enter in the command line
    //  "change"
    //  "cancel"
    //  "complete"
    registerCallback: function (type, mode, func) {
        if (!(type in this._callbacks))
            this._callbacks[type] = {};
        this._callbacks[type][mode] = func;
    },

    triggerCallback: function (type, mode, data) {
        if (this._callbacks[type] && this._callbacks[type][mode])
            this._callbacks[type][mode].call(this, data);
    },

    runSilently: function (func, self) {
        let wasSilent = this._silent;
        this._silent = true;
        try {
            func.call(self);
        }
        finally {
            this._silent = wasSilent;
        }
    },

    get command() {
        try {
            // The long path is because of complications with the
            // completion preview.
            return this.widgets.command.inputField.editor.rootElement.firstChild.textContent;
        }
        catch (e) {
            return this.widgets.command.value;
        }
    },
    set command(cmd) this.widgets.command.value = cmd,

    get message() this.widgets.message.value,

    /**
     * Open the command line. The main mode is set to
     * COMMAND_LINE, the extended mode to <b>extendedMode</b>.
     * Further, callbacks defined for <b>extendedMode</b> are
     * triggered as appropriate (see {@link #registerCallback}).
     *
     * @param {string} prompt
     * @param {string} cmd
     * @param {number} extendedMode
     */
    open: function open(prompt, cmd, extendedMode) {
        // save the current prompts, we need it later if the command widget
        // receives focus without calling the this.open() method
        this._currentPrompt = prompt || "";
        this._currentCommand = cmd || "";
        this._currentExtendedMode = extendedMode || null;
        this._keepCommand = false;

        this._setPrompt(this._currentPrompt);
        this._setCommand(this._currentCommand);
        this.widgets.commandline.collapsed = false;

        modes.set(modes.COMMAND_LINE, this._currentExtendedMode);

        this.widgets.command.focus();

        this._history = CommandLine.History(this.widgets.command.inputField, (modes.extended == modes.EX) ? "command" : "search");
        this._completions = CommandLine.Completions(this.widgets.command.inputField);

        // open the completion list automatically if wanted
        if (cmd.length)
            commandline.triggerCallback("change", this._currentExtendedMode, cmd);
    },

    /**
     * Closes the command line. This is ordinarily triggered automatically
     * by a mode change. Will not hide the command line immediately if
     * called directly after a successful command, otherwise it will.
     */
    close: function close() {
        let mode = this._currentExtendedMode;
        this._currentExtendedMode = null;
        commandline.triggerCallback("cancel", mode);

        if (this._completions)
            this._completions.previewClear();
        if (this._history)
            this._history.save();

        this.resetCompletions(); // cancels any asynchronous completion still going on, must be before we set completions = null
        this._completions = null;
        this._history = null;

        statusline.updateProgress(""); // we may have a "match x of y" visible
        dactyl.focusContent(false);

        this.widgets.multilineInput.collapsed = true;
        this._completionList.hide();

        if (!this._keepCommand || this._silent || this._quiet) {
            this.widgets.mowContainer.collapsed = true;
            commandline.updateMorePrompt();
            this.hide();
        }
        if (!this.widgets.mowContainer.collapsed) {
            modes.set(modes.COMMAND_LINE, modes.OUTPUT_MULTILINE);
            commandline.updateMorePrompt();
        }
        this._keepCommand = false;
    },

    /**
     * Displays the multi-line output of a command, preceded by the last
     * executed ex command string.
     * 
     * @param {XML} xml The output as an E4X XML object.
     */
    commandOutput: function (xml) {
        XML.ignoreWhitespace = false;
        XML.prettyPrinting = false;
        this.echo(<>:{this.command}<br/>{xml}</>, this.HIGHLIGHT_NORMAL, this.FORCE_MULTILINE);
    },

    /**
     * Hides the command line, and shows any status messages that
     * are under it.
     */
    hide: function hide() {
        this.widgets.commandline.collapsed = true;
    },

    /**
     * Output the given string onto the command line. With no flags, the
     * message will be shown in the status line if it's short enough to
     * fit, and contains no new lines, and isn't XML. Otherwise, it will be
     * shown in the MOW.
     *
     * @param {string} str
     * @param {string} highlightGroup The Highlight group for the
     *     message.
     * @default "Normal"
     * @param {number} flags Changes the behavior as follows:
     *   commandline.APPEND_TO_MESSAGES - Causes message to be added to the
     *          messages history, and shown by :messages.
     *   commandline.FORCE_SINGLELINE   - Forbids the command from being
     *          pushed to the MOW if it's too long or of there are already
     *          status messages being shown.
     *   commandline.DISALLOW_MULTILINE - Cancels the operation if the MOW
     *          is already visible.
     *   commandline.FORCE_MULTILINE    - Forces the message to appear in
     *          the MOW.
     */
    echo: requiresMainThread(function echo(str, highlightGroup, flags) {
        // dactyl.echo uses different order of flags as it omits the highlight group, change commandline.echo argument order? --mst
        if (this._silent)
            return;

        highlightGroup = highlightGroup || this.HL_NORMAL;

        if (flags & this.APPEND_TO_MESSAGES) {
            let message = isobject(str) ? str : { message: str };
            this._messageHistory.add(update({ highlight: highlightGroup }, message));
            str = message.message;
        }

        if ((flags & this.ACTIVE_WINDOW) &&
            window != services.get("windowWatcher").activeWindow &&
            services.get("windowWatcher").activeWindow.dactyl)
            return;

        if ((flags & this.DISALLOW_MULTILINE) && !this.widgets.mowContainer.collapsed)
            return;

        let single = flags & (this.FORCE_SINGLELINE | this.DISALLOW_MULTILINE);
        let action = this._echoLine;

        if (single)
            this._lastEcho = null;
        else {
            if (this.widgets.message.value == this._lastEcho)
                this._echoMultiline(<span highlight="Message">{this._lastEcho}</span>,
                                    this.highlightGroup);
            this._lastEcho = (action == this._echoLine) && str;
        }

        // TODO: this is all a bit convoluted - clean up.
        // assume that FORCE_MULTILINE output is fully styled
        if (!(flags & this.FORCE_MULTILINE) && !single
            && (!this.widgets.mowContainer.collapsed || this.widgets.message.value == this._lastEcho)) {

            highlightGroup += " Message";
            action = this._echoMultiline;
        }

        if ((flags & this.FORCE_MULTILINE) || (/\n/.test(str) || typeof str == "xml") && !(flags & this.FORCE_SINGLELINE))
            action = this._echoMultiline;

        if (action)
            action.call(this, str, highlightGroup, single);
    }),

    /**
     * Prompt the user. Sets modes.main to COMMAND_LINE, which the user may
     * pop at any time to close the prompt.
     *
     * @param {string} prompt The input prompt to use.
     * @param {function(string)} callback
     * @param {Object} extra
     * @... {function} onChange - A function to be called with the current
     *     input every time it changes.
     * @... {function(CompletionContext)} completer - A completion function
     *     for the user's input.
     * @... {string} promptHighlight - The HighlightGroup used for the
     *     prompt. @default "Question"
     * @... {string} default - The initial value that will be returned
     *     if the user presses <CR> straightaway. @default ""
     */
    input: function _input(prompt, callback, extra) {
        extra = extra || {};

        this._input = {
            submit: callback,
            change: extra.onChange,
            complete: extra.completer,
            cancel: extra.onCancel
        };

        modes.push(modes.COMMAND_LINE, modes.PROMPT);
        this._currentExtendedMode = modes.PROMPT;

        this._setPrompt(prompt, extra.promptHighlight || this.HL_QUESTION);
        this._setCommand(extra.default || "");
        this.widgets.commandline.collapsed = false;
        this.widgets.command.focus();

        this._completions = CommandLine.Completions(this.widgets.command.inputField);
    },

    /**
     * Get a multiline input from a user, up to but not including the line
     * which matches the given regular expression. Then execute the
     * callback with that string as a parameter.
     *
     * @param {RegExp} untilRegexp
     * @param {function(string)} callbackFunc
     */
    // FIXME: Buggy, especially when pasting. Shouldn't use a RegExp.
    inputMultiline: function inputMultiline(untilRegexp, callbackFunc) {
        // Kludge.
        let cmd = !this.widgets.command.collapsed && this.command;
        modes.push(modes.COMMAND_LINE, modes.INPUT_MULTILINE);
        if (cmd != false)
            this._echoLine(cmd, this.HL_NORMAL);

        // save the arguments, they are needed in the event handler onEvent
        this._multilineRegexp = untilRegexp;
        this._multilineCallback = callbackFunc;

        this.widgets.multilineInput.collapsed = false;
        this.widgets.multilineInput.value = "";
        this._autosizeMultilineInputWidget();

        this.timeout(function () { this.widgets.multilineInput.focus(); }, 10);
    },

    /**
     * Handles all command-line events. All key events are passed here when
     * COMMAND_LINE mode is active, as well as all input, keyup, focus, and
     * blur events sent to the command-line XUL element.
     *
     * @param {Event} event
     * @private
     */
    onEvent: function onEvent(event) {
        try {
            let command = this.command;

            if (event.type == "blur") {
                // prevent losing focus, there should be a better way, but it just didn't work otherwise
                this.timeout(function () {
                    if (this.commandVisible && event.originalTarget == this.widgets.command.inputField)
                        this.widgets.command.inputField.focus();
                }, 0);
            }
            else if (event.type == "focus") {
                if (!this.commandVisible && event.target == this.widgets.command.inputField) {
                    event.target.blur();
                    dactyl.beep();
                }
            }
            else if (event.type == "input") {
                this.resetCompletions();
                commandline.triggerCallback("change", this._currentExtendedMode, command);
            }
            else if (event.type == "keypress") {
                let key = events.toString(event);
                if (this._completions)
                    this._completions.previewClear();
                if (!this._currentExtendedMode)
                    return;

                // user pressed <Enter> to carry out a command
                // user pressing <Esc> is handled in the global onEscape
                //   FIXME: <Esc> should trigger "cancel" event
                if (events.isAcceptKey(key)) {
                    let mode = this._currentExtendedMode; // save it here, as modes.pop() resets it
                    this._keepCommand = !userContext.hidden_option_no_command_afterimage;
                    this._currentExtendedMode = null; // Don't let modes.pop trigger "cancel"
                    modes.pop(!this._silent);
                    commandline.triggerCallback("submit", mode, command);
                }
                // user pressed <Up> or <Down> arrow to cycle this._history completion
                else if (/^<(Up|Down|S-Up|S-Down|PageUp|PageDown)>$/.test(key)) {
                    // prevent tab from moving to the next field
                    event.preventDefault();
                    event.stopPropagation();

                    dactyl.assert(this._history);
                    this._history.select(/Up/.test(key), !/(Page|S-)/.test(key));
                }
                // user pressed <Tab> to get completions of a command
                else if (/^<(Tab|S-Tab)>$/.test(key)) {
                    // prevent tab from moving to the next field
                    event.preventDefault();
                    event.stopPropagation();

                    this._tabTimer.tell(event);
                }
                else if (key == "<BS>") {
                    // reset the tab completion
                    //this.resetCompletions();

                    // and blur the command line if there is no text left
                    if (command.length == 0) {
                        commandline.triggerCallback("cancel", this._currentExtendedMode);
                        modes.pop();
                    }
                }
                else {
                    //this.resetCompletions();
                }
                // allow this event to be handled by the host app
            }
            else if (event.type == "keyup") {
                let key = events.toString(event);
                if (/^<(Tab|S-Tab)>$/.test(key))
                    this._tabTimer.flush();
            }
        }
        catch (e) {
            dactyl.reportError(e, true);
        }
    },

    /**
     * Multiline input events, they will come straight from
     * #dactyl-multiline-input in the XUL.
     *
     * @param {Event} event
     */
    onMultilineInputEvent: function onMultilineInputEvent(event) {
        if (event.type == "keypress") {
            let key = events.toString(event);
            if (events.isAcceptKey(key)) {
                let text = this.widgets.multilineInput.value.substr(0, this.widgets.multilineInput.selectionStart);
                if (text.match(this._multilineRegexp)) {
                    text = text.replace(this._multilineRegexp, "");
                    modes.pop();
                    this.widgets.multilineInput.collapsed = true;
                    this._multilineCallback.call(this, text);
                }
            }
            else if (events.isCancelKey(key)) {
                modes.pop();
                this.widgets.multilineInput.collapsed = true;
            }
        }
        else if (event.type == "blur") {
            if (modes.extended & modes.INPUT_MULTILINE)
                this.timeout(function () { this.widgets.multilineInput.inputField.focus(); }, 0);
        }
        else if (event.type == "input")
            this._autosizeMultilineInputWidget();
        return true;
    },

    /**
     * Handle events when we are in multiline output mode, these come from
     * dactyl when modes.extended & modes.MULTILINE_OUTPUT and also from
     * #dactyl-multiline-output in the XUL.
     *
     * @param {Event} event
     */
    // FIXME: if 'more' is set and the MOW is not scrollable we should still
    // allow a down motion after an up rather than closing
    onMultilineOutputEvent: function onMultilineOutputEvent(event) {
        let win = this.widgets.multilineOutput.contentWindow;

        let showMoreHelpPrompt = false;
        let showMorePrompt = false;
        let closeWindow = false;
        let passEvent = false;

        let key = events.toString(event);

        // TODO: Wouldn't multiple handlers be cleaner? --djk
        if (event.type == "click" && event.target instanceof HTMLAnchorElement) {
            function openLink(where) {
                event.preventDefault();
                // FIXME: Why is this needed? --djk
                if (event.target.getAttribute("href") == "#")
                    dactyl.open(event.target.textContent, where);
                else
                    dactyl.open(event.target.href, where);
            }

            switch (key) {
            case "<LeftMouse>":
                if (event.originalTarget.getAttributeNS(NS.uri, "highlight") == "URL buffer-list") {
                    event.preventDefault();
                    tabs.select(parseInt(event.originalTarget.parentNode.parentNode.firstChild.textContent, 10) - 1);
                }
                else
                    openLink(dactyl.CURRENT_TAB);
                break;
            case "<MiddleMouse>":
            case "<C-LeftMouse>":
            case "<C-M-LeftMouse>":
                openLink({ where: dactyl.NEW_TAB, background: true });
                break;
            case "<S-MiddleMouse>":
            case "<C-S-LeftMouse>":
            case "<C-M-S-LeftMouse>":
                openLink({ where: dactyl.NEW_TAB, background: false });
                break;
            case "<S-LeftMouse>":
                openLink(dactyl.NEW_WINDOW);
                break;
            }

            return;
        }

        if (this._startHints) {
            statusline.updateInputBuffer("");
            this._startHints = false;
            hints.show(key, undefined, win);
            return;
        }

        function isScrollable() !win.scrollMaxY == 0;
        function atEnd() win.scrollY / win.scrollMaxY >= 1;

        switch (key) {
        case "<Esc>":
            closeWindow = true;
            break; // handled globally in events.js:onEscape()

        case ":":
            commandline.open(":", "", modes.EX);
            return;

        // down a line
        case "j":
        case "<Down>":
            if (options["more"] && isScrollable())
                win.scrollByLines(1);
            else
                passEvent = true;
            break;

        case "<C-j>":
        case "<C-m>":
        case "<Return>":
            if (options["more"] && isScrollable() && !atEnd())
                win.scrollByLines(1);
            else
                closeWindow = true; // don't propagate the event for accept keys
            break;

        // up a line
        case "k":
        case "<Up>":
        case "<BS>":
            if (options["more"] && isScrollable())
                win.scrollByLines(-1);
            else if (options["more"] && !isScrollable())
                showMorePrompt = true;
            else
                passEvent = true;
            break;

        // half page down
        case "d":
            if (options["more"] && isScrollable())
                win.scrollBy(0, win.innerHeight / 2);
            else
                passEvent = true;
            break;

        // TODO: <LeftMouse> on the prompt line should scroll one page
        // page down
        case "f":
            if (options["more"] && isScrollable())
                win.scrollByPages(1);
            else
                passEvent = true;
            break;

        case "<Space>":
        case "<PageDown>":
            if (options["more"] && isScrollable() && !atEnd())
                win.scrollByPages(1);
            else
                passEvent = true;
            break;

        // half page up
        case "u":
            // if (more and scrollable)
            if (options["more"] && isScrollable())
                win.scrollBy(0, -(win.innerHeight / 2));
            else
                passEvent = true;
            break;

        // page up
        case "b":
            if (options["more"] && isScrollable())
                win.scrollByPages(-1);
            else if (options["more"] && !isScrollable())
                showMorePrompt = true;
            else
                passEvent = true;
            break;

        case "<PageUp>":
            if (options["more"] && isScrollable())
                win.scrollByPages(-1);
            else
                passEvent = true;
            break;

        // top of page
        case "g":
            if (options["more"] && isScrollable())
                win.scrollTo(0, 0);
            else if (options["more"] && !isScrollable())
                showMorePrompt = true;
            else
                passEvent = true;
            break;

        // bottom of page
        case "G":
            if (options["more"] && isScrollable() && !atEnd())
                win.scrollTo(0, win.scrollMaxY);
            else
                passEvent = true;
            break;

        // copy text to clipboard
        case "<C-y>":
            dactyl.clipboardWrite(win.getSelection());
            break;

        // close the window
        case "q":
            closeWindow = true;
            break;

        case ";":
            statusline.updateInputBuffer(";");
            this._startHints = true;
            break;

        // unmapped key
        default:
            if (!options["more"] || !isScrollable() || atEnd() || events.isCancelKey(key))
                passEvent = true;
            else
                showMoreHelpPrompt = true;
        }

        if (passEvent || closeWindow) {
            modes.pop();

            if (passEvent)
                events.onKeyPress(event);
        }
        else
            commandline.updateMorePrompt(showMorePrompt, showMoreHelpPrompt);
    },

    getSpaceNeeded: function getSpaceNeeded() {
        let rect = this.widgets.commandline.getBoundingClientRect();
        let offset = rect.bottom - window.innerHeight;
        return Math.max(0, offset);
    },

    /**
     * Update or remove the multiline output widget's "MORE" prompt.
     *
     * @param {boolean} force If true, "-- More --" is shown even if we're
     *     at the end of the output.
     * @param {boolean} showHelp When true, show the valid key sequences
     *     and what they do.
     */
    updateMorePrompt: function updateMorePrompt(force, showHelp) {
        if (this.widgets.mowContainer.collapsed) {
            this._echoLine("", this.HL_NORMAL);
            return;
        }

        let win = this.widgets.multilineOutput.contentWindow;
        function isScrollable() !win.scrollMaxY == 0;
        function atEnd() win.scrollY / win.scrollMaxY >= 1;

        if (showHelp)
            this._echoLine("-- More -- SPACE/d/j: screen/page/line down, b/u/k: up, q: quit", this.HL_MOREMSG, true);
        else if (force || (options["more"] && isScrollable() && !atEnd()))
            this._echoLine("-- More --", this.HL_MOREMSG, true);
        else
            this._echoLine("Press ENTER or type command to continue", this.HL_QUESTION, true);
    },

    /**
     * Changes the height of the message window to fit in the available space.
     *
     * @param {boolean} open If true, the widget will be opened if it's not
     *     already so.
     */
    updateOutputHeight: function updateOutputHeight(open, extra) {
        if (!open && this.widgets.mowContainer.collapsed)
            return;

        let doc = this.widgets.multilineOutput.contentDocument;

        let availableHeight = config.outputHeight;
        if (!this.widgets.mowContainer.collapsed)
            availableHeight += parseFloat(this.widgets.mowContainer.height);
        availableHeight -= extra || 0;

        doc.body.style.minWidth = this.widgets.commandline.scrollWidth + "px";
        this.widgets.mowContainer.height = Math.min(doc.height, availableHeight) + "px";
        this.timeout(function ()
            this.widgets.mowContainer.height = Math.min(doc.height, availableHeight) + "px",
            0);

        doc.body.style.minWidth = "";
        this.widgets.mowContainer.collapsed = false;
    },

    resetCompletions: function resetCompletions() {
        if (this._completions) {
            this._completions.context.cancelAll();
            this._completions.wildIndex = -1;
            this._completions.previewClear();
        }
        if (this._history)
            this._history.reset();
    }
}, {
    /**
     * A class for managing the history of an input field.
     *
     * @param {HTMLInputElement} inputField
     * @param {string} mode The mode for which we need history.
     */
    History: Class("History", {
        init: function (inputField, mode) {
            this.mode = mode;
            this.input = inputField;
            this.store = storage["history-" + mode];
            this.reset();
        },
        /**
         * Reset the history index to the first entry.
         */
        reset: function () {
            this.index = null;
        },
        /**
         * Save the last entry to the permanent store. All duplicate entries
         * are removed and the list is truncated, if necessary.
         */
        save: function () {
            if (events.feedingKeys)
                return;
            let str = this.input.value;
            if (/^\s*$/.test(str))
                return;
            this.store.mutate("filter", function (line) (line.value || line) != str);
            try {
                this.store.push({ value: str, timestamp: Date.now()*1000, privateData: this.checkPrivate(str) });
            }
            catch (e) {
                dactyl.reportError(e);
            }
            this.store.truncate(options["history"], true);
        },
        /**
         * @property {function} Returns whether a data item should be
         * considered private.
         */
        checkPrivate: function (str) {
            // Not really the ideal place for this check.
            if (this.mode == "command")
                return commands.hasPrivateData(str);
            return false;
        },
        /**
         * Replace the current input field value.
         *
         * @param {string} val The new value.
         */
        replace: function (val) {
            this.input.value = val;
            commandline.triggerCallback("change", this._currentExtendedMode, val);
        },

        /**
         * Move forward or backward in history.
         *
         * @param {boolean} backward Direction to move.
         * @param {boolean} matchCurrent Search for matches starting
         *      with the current input value.
         */
        select: function (backward, matchCurrent) {
            // always reset the tab completion if we use up/down keys
            commandline._completions.reset();

            let diff = backward ? -1 : 1;

            if (this.index == null) {
                this.original = this.input.value;
                this.index = this.store.length;
            }

            // search the this._history for the first item matching the current
            // commandline string
            while (true) {
                this.index += diff;
                if (this.index < 0 || this.index > this.store.length) {
                    this.index = Math.constrain(this.index, 0, this.store.length);
                    dactyl.beep();
                    // I don't know why this kludge is needed. It
                    // prevents the caret from moving to the end of
                    // the input field.
                    if (this.input.value == "") {
                        this.input.value = " ";
                        this.input.value = "";
                    }
                    break;
                }

                let hist = this.store.get(this.index);
                // user pressed DOWN when there is no newer history item
                if (!hist)
                    hist = this.original;
                else
                    hist = (hist.value || hist);

                if (!matchCurrent || hist.substr(0, this.original.length) == this.original) {
                    this.replace(hist);
                    break;
                }
            }
        }
    }),

    /**
     * A class for tab completions on an input field.
     *
     * @param {Object} input
     */
    Completions: Class("Completions", {
        init: function (input) {
            this.context = CompletionContext(input.QueryInterface(Ci.nsIDOMNSEditableElement).editor);
            this.context.onUpdate = this.closure._reset;
            this.editor = input.editor;
            this.selected = null;
            this.wildmode = options.get("wildmode");
            this.itemList = commandline._completionList;
            this.itemList.setItems(this.context);
            this.reset();
        },

        UP: {},
        DOWN: {},
        PAGE_UP: {},
        PAGE_DOWN: {},
        RESET: null,

        get completion() {
            let str = commandline.command;
            return str.substring(this.prefix.length, str.length - this.suffix.length);
        },
        set completion(completion) {
            this.previewClear();

            // Change the completion text.
            // The second line is a hack to deal with some substring
            // preview corner cases.
            commandline.widgets.command.value = this.prefix + completion + this.suffix;
            this.editor.selection.focusNode.textContent = commandline.widgets.command.value;

            // Reset the caret to one position after the completion.
            this.caret = this.prefix.length + completion.length;
        },

        get caret() this.editor.selection.focusOffset,
        set caret(offset) {
            commandline.widgets.command.selectionStart = offset;
            commandline.widgets.command.selectionEnd = offset;
        },

        get start() this.context.allItems.start,

        get items() this.context.allItems.items,

        get substring() this.context.longestAllSubstring,

        get wildtype() this.wildtypes[this.wildIndex] || "",

        get wildtypes() this.wildmode.values,

        complete: function complete(show, tabPressed) {
            this.context.reset();
            this.context.tabPressed = tabPressed;
            commandline.triggerCallback("complete", commandline._currentExtendedMode, this.context);
            this.context.updateAsync = true;
            this.reset(show, tabPressed);
            this.wildIndex = 0;
        },

        haveType: function (type)
            this.wildmode.checkHas(this.wildtype, type == "first" ? "" : type),

        preview: function preview() {
            this.previewClear();
            if (this.wildIndex < 0 || this.suffix || !this.items.length)
                return;

            let substring = "";
            switch (this.wildtype.replace(/.*:/, "")) {
            case "":
                substring = this.items[0].result;
                break;
            case "longest":
                if (this.items.length > 1) {
                    substring = this.substring;
                    break;
                }
                // Fallthrough
            case "full":
                let item = this.items[this.selected != null ? this.selected + 1 : 0];
                if (item)
                    substring = item.result;
                break;
            }

            // Don't show 1-character substrings unless we've just hit backspace
            if (substring.length < 2 && (!this._lastSubstring || this._lastSubstring.indexOf(substring) != 0))
                return;
            this._lastSubstring = substring;

            let value = this.completion;
            if (util.compareIgnoreCase(value, substring.substr(0, value.length)))
                return;
            substring = substring.substr(value.length);
            this.removeSubstring = substring;

            let node = util.xmlToDom(<span highlight="Preview">{substring}</span>,
                document);
            let start = this.caret;
            this.editor.insertNode(node, this.editor.rootElement, 1);
            this.caret = start;
        },

        previewClear: function previewClear() {
            let node = this.editor.rootElement.firstChild;
            if (node && node.nextSibling) {
                try {
                    this.editor.deleteNode(node.nextSibling);
                }
                catch (e) {
                    node.nextSibling.textContent = "";
                }
            }
            else if (this.removeSubstring) {
                let str = this.removeSubstring;
                let cmd = commandline.widgets.command.value;
                if (cmd.substr(cmd.length - str.length) == str)
                    commandline.widgets.command.value = cmd.substr(0, cmd.length - str.length);
            }
            delete this.removeSubstring;
        },

        reset: function reset(show) {
            this.wildIndex = -1;

            this.prefix = this.context.value.substring(0, this.start);
            this.value  = this.context.value.substring(this.start, this.caret);
            this.suffix = this.context.value.substring(this.caret);

            if (show) {
                this.itemList.reset();
                this.selected = null;
                this.wildIndex = 0;
            }

            this.preview();
        },

        _reset: function _reset() {
            let value = this.editor.selection.focusNode.textContent;
            this.prefix = value.substring(0, this.start);
            this.value  = value.substring(this.start, this.caret);
            this.suffix = value.substring(this.caret);

            this.itemList.reset();
            this.itemList.selectItem(this.selected);

            this.preview();
        },

        select: function select(idx) {
            switch (idx) {
            case this.UP:
                if (this.selected == null)
                    idx = -2;
                else
                    idx = this.selected - 1;
                break;
            case this.DOWN:
                if (this.selected == null)
                    idx = 0;
                else
                    idx = this.selected + 1;
                break;
            case this.RESET:
                idx = null;
                break;
            default:
                idx = Math.constrain(idx, 0, this.items.length - 1);
                break;
            }

            if (idx == -1 || this.items.length && idx >= this.items.length || idx == null) {
                // Wrapped. Start again.
                this.selected = null;
                this.completion = this.value;
            }
            else {
                // Wait for contexts to complete if necessary.
                // FIXME: Need to make idx relative to individual contexts.
                let list = this.context.contextList;
                if (idx == -2)
                    list = list.slice().reverse();
                let n = 0;
                try {
                    this.waiting = true;
                    for (let [, context] in Iterator(list)) {
                        function done() !(idx >= n + context.items.length || idx == -2 && !context.items.length);
                        while (context.incomplete && !done())
                            util.threadYield(false, true);

                        if (done())
                            break;

                        n += context.items.length;
                    }
                }
                finally {
                    this.waiting = false;
                }

                // See previous FIXME. This will break if new items in
                // a previous context come in.
                if (idx < 0)
                    idx = this.items.length - 1;
                if (this.items.length == 0)
                    return;

                this.selected = idx;
                this.completion = this.items[idx].result;
            }

            this.itemList.selectItem(idx);
        },

        tabs: [],

        tab: function tab(reverse) {
            commandline._autocompleteTimer.flush();
            // Check if we need to run the completer.
            if (this.context.waitingForTab || this.wildIndex == -1)
                this.complete(true, true);

            this.tabs.push(reverse);
            if (this.waiting)
                return;

            while (this.tabs.length) {
                this.wildIndex = Math.min(this.wildIndex, this.wildtypes.length - 1);

                reverse = this.tabs.shift();
                switch (this.wildtype.replace(/.*:/, "")) {
                case "":
                    this.select(0);
                    break;
                case "longest":
                    if (this.items.length > 1) {
                        if (this.substring && this.substring != this.completion)
                            this.completion = this.substring;
                        break;
                    }
                    // Fallthrough
                case "full":
                    this.select(reverse ? this.UP : this.DOWN);
                    break;
                }

                if (this.haveType("list"))
                    this.itemList.show();

                this.wildIndex++;
                this.preview();

                commandline._statusTimer.tell();
            }

            if (this.items.length == 0)
                dactyl.beep();
        }
    }),

    /**
     * Evaluate a JavaScript expression and return a string suitable
     * to be echoed.
     *
     * @param {string} arg
     * @param {boolean} useColor When true, the result is a
     *     highlighted XML object.
     */
    echoArgumentToString: function (arg, useColor) {
        if (!arg)
            return "";

        try {
            arg = dactyl.usereval(arg);
        }
        catch (e) {
            dactyl.echoerr(e);
            return null;
        }

        if (typeof arg === "object")
            arg = util.objectToString(arg, useColor);
        else if (typeof arg === "string" && /\n/.test(arg))
            arg = <span highlight="CmdOutput">{arg}</span>;
        else
            arg = String(arg);

        return arg;
    }
}, {
    commands: function () {
        [
            {
                name: "ec[ho]",
                description: "Echo the expression",
                action: dactyl.echo
            },
            {
                name: "echoe[rr]",
                description: "Echo the expression as an error message",
                action: dactyl.echoerr
            },
            {
                name: "echom[sg]",
                description: "Echo the expression as an informational message",
                action: dactyl.echomsg
            }
        ].forEach(function (command) {
            commands.add([command.name],
                command.description,
                function (args) {
                    let str = CommandLine.echoArgumentToString(args.string, true);
                    if (str != null)
                        command.action(str);
                }, {
                    completer: function (context) completion.javascript(context),
                    literal: 0
                });
        });

        commands.add(["mes[sages]"],
            "Display previously shown messages",
            function () {
                // TODO: are all messages single line? Some display an aggregation
                //       of single line messages at least. E.g. :source
                if (commandline._messageHistory.length == 1) {
                    let message = commandline._messageHistory.messages[0];
                    commandline.echo(message.message, message.highlight, commandline.FORCE_SINGLELINE);
                }
                else if (commandline._messageHistory.length > 1) {
                    XML.ignoreWhitespace = false;
                    commandline.commandOutput(
                        template.map(commandline._messageHistory.messages, function (message)
                            <div highlight={message.highlight + " Message"}>{message.message}</div>));;
                }
            },
            { argCount: "0" });

        commands.add(["messc[lear]"],
            "Clear the message this._history",
            function () { commandline._messageHistory.clear(); },
            { argCount: "0" });

        commands.add(["sil[ent]"],
            "Run a command silently",
            function (args) {
                commandline.runSilently(function () dactyl.execute(args[0], null, true));
            }, {
                completer: function (context) completion.ex(context),
                literal: 0,
                subCommand: 0
            });
    },
    mappings: function () {
        var myModes = [modes.COMMAND_LINE];

        // TODO: move "<Esc>", "<C-[>" here from mappings
        mappings.add(myModes,
            ["<C-c>"], "Focus content",
            function () { events.onEscape(); });

        // Any "non-keyword" character triggers abbreviation expansion
        // TODO: Add "<CR>" and "<Tab>" to this list
        //       At the moment, adding "<Tab>" breaks tab completion. Adding
        //       "<CR>" has no effect.
        // TODO: Make non-keyword recognition smarter so that there need not
        //       be two lists of the same characters (one here and a regex in
        //       mappings.js)
        mappings.add(myModes,
            ["<Space>", '"', "'"], "Expand command line abbreviation",
            function () {
                commandline.resetCompletions();
                return editor.expandAbbreviation("c");
            },
            { route: true });

        mappings.add(myModes,
            ["<C-]>", "<C-5>"], "Expand command line abbreviation",
            function () { editor.expandAbbreviation("c"); });

        mappings.add([modes.NORMAL],
            ["g<"], "Redisplay the last command output",
            function () {
                dactyl.assert(this._lastMowOutput);
                this._echoMultiline(this._lastMowOutput, commandline.HL_NORMAL);
            });
    },
    options: function () {
        options.add(["history", "hi"],
            "Number of Ex commands and search patterns to store in the command-line this._history",
            "number", 500,
            { validator: function (value) value >= 0 });

        options.add(["maxitems"],
            "Maximum number of items to display at once",
            "number", 20,
            { validator: function (value) value >= 1 });

        options.add(["messages", "msgs"],
            "Number of messages to store in the message this._history",
            "number", 100,
            { validator: function (value) value >= 0 });

        options.add(["more"],
            "Pause the message list window when more than one screen of listings is displayed",
            "boolean", true);

        options.add(["showmode", "smd"],
            "Show the current mode in the command line",
            "boolean", true);
    },
    sanitizer: function () {
        sanitizer.addItem("commandline", {
            description: "Command-line and search history",
            action: function (timespan, host) {
                if (!host)
                    storage["history-search"].mutate("filter", function (item) !timespan.contains(item.timestamp));
                storage["history-command"].mutate("filter", function (item) 
                    !(timespan.contains(item.timestamp) && (!host || commands.hasDomain(item.value, host))));
            }
        });
        // Delete history-like items from the commandline and messages on history purge
        sanitizer.addItem("history", {
            action: function (timespan, host) {
                storage["history-command"].mutate("filter", function (item) 
                    !(timespan.contains(item.timestamp) && (host ? commands.hasDomain(item.value, host) : item.privateData)));
                commandline._messageHistory.filter(function (item) !timespan.contains(item.timestamp * 1000) ||
                    !item.domains && !item.privateData ||
                    host && (!item.domains || !item.domains.some(function (d) util.isSubdomain(d, host))));
            }
        });
        sanitizer.addItem("messages", {
            description: "Saved :messages",
            action: function (timespan, host) {
                commandline._messageHistory.filter(function (item) !timespan.contains(item.timestamp * 1000) ||
                    host && (!item.domains || !item.domains.some(function (d) util.isSubdomain(d, host))));
            }
        });
    },
    styles: function () {
        let fontSize = util.computedStyle(document.getElementById(config.mainWindowId)).fontSize;
        styles.registerSheet("chrome://dactyl/skin/dactyl.css");
        styles.addSheet(true, "font-size", "chrome://dactyl/content/buffer.xhtml",
            "body { font-size: " + fontSize + "; }");
    }
});

/**
 * The list which is used for the completion box (and QuickFix window in
 * future).
 *
 * @param {string} id The id of the iframe which will display the list. It
 *     must be in its own container element, whose height it will update as
 *     necessary.
 */
const ItemList = Class("ItemList", {
    init: function (id) {
        this._completionElements = [];

        var iframe = document.getElementById(id);

        this._doc = iframe.contentDocument;
        this._win = iframe.contentWindow;
        this._container = iframe.parentNode;

        this._doc.body.id = id + "-content";
        this._doc.body.appendChild(this._doc.createTextNode(""));
        this._doc.body.style.borderTop = "1px solid black"; // FIXME: For cases where completions/MOW are shown at once, or ls=0. Should use :highlight.

        this._gradient = template.gradient("GradientLeft", "GradientRight");

        this._items = null;
        this._startIndex = -1;  // The index of the first displayed item
        this._endIndex = -1;    // The index one *after* the last displayed item
        this._selIndex = -1;    // The index of the currently selected element
        this._div = null;
        this._divNodes = {};
        this._minHeight = 0;
    },

    _dom: function (xml, map) util.xmlToDom(xml, this._doc, map),

    _autoSize: function () {
        if (this._container.collapsed)
            this._div.style.minWidth = document.getElementById("dactyl-commandline").scrollWidth + "px";

        this._minHeight = Math.max(this._minHeight, 
            this._win.scrollY + this._divNodes.completions.getBoundingClientRect().bottom);

        if (this._container.collapsed)
            this._div.style.minWidth = "";

        // FIXME: Belongs elsewhere.
        commandline.updateOutputHeight(false, Math.max(0, this._minHeight - this._container.height));

        this._container.height = this._minHeight;
        this._container.height -= commandline.getSpaceNeeded()
        commandline.updateOutputHeight(false);
        this.timeout(function () { this._container.height -= commandline.getSpaceNeeded(); }, 0);
    },

    _getCompletion: function (index) this._completionElements.snapshotItem(index - this._startIndex),

    _init: function () {
        this._div = this._dom(
            <div class="ex-command-output" highlight="Normal" style="white-space: nowrap">
                <div highlight="Completions" key="noCompletions"><span highlight="Title">No Completions</span></div>
                <div key="completions"/>
                <div highlight="Completions">
                {
                    template.map(util.range(0, options["maxitems"] * 2), function (i)
                    <span highlight="CompItem">
                        <li highlight="NonText">~</li>
                    </span>)
                }
                </div>
            </div>, this._divNodes);
        this._doc.body.replaceChild(this._div, this._doc.body.firstChild);
        //div.scrollIntoView(true);

        this._items.contextList.forEach(function init_eachContext(context) {
            delete context.cache.nodes;
            if (!context.items.length && !context.message && !context.incomplete)
                return;
            context.cache.nodes = [];
            this._dom(<div key="root" highlight="CompGroup">
                    <div highlight="Completions">
                        { context.createRow(context.title || [], "CompTitle") }
                    </div>
                    { this._gradient }
                    <div key="message" highlight="CompMsg"/>
                    <div key="up" highlight="CompLess"/>
                    <div key="items" highlight="Completions"/>
                    <div key="waiting" highlight="CompMsg">{ItemList.WAITING_MESSAGE}</div>
                    <div key="down" highlight="CompMore"/>
                </div>, context.cache.nodes);
            this._divNodes.completions.appendChild(context.cache.nodes.root);
        }, this);

        this.timeout(this._autoSize, 0);
    },

    /**
     * Uses the entries in "items" to fill the listbox and does incremental
     * filling to speed up things.
     *
     * @param {number} offset Start at this index and show options["maxitems"].
     */
    _fill: function (offset) {
        XML.ignoreWhiteSpace = false;
        let diff = offset - this._startIndex;
        if (this._items == null || offset == null || diff == 0 || offset < 0)
            return false;

        this._startIndex = offset;
        this._endIndex = Math.min(this._startIndex + options["maxitems"], this._items.allItems.items.length);

        let haveCompletions = false;
        let off = 0;
        let end = this._startIndex + options["maxitems"];
        function getRows(context) {
            function fix(n) Math.constrain(n, 0, len);
            let len = context.items.length;
            let start = off;
            end -= !!context.message + context.incomplete;
            off += len;

            let s = fix(offset - start), e = fix(end - start);
            return [s, e, context.incomplete && e >= offset && off - 1 < end];
        }

        this._items.contextList.forEach(function fill_eachContext(context) {
            let nodes = context.cache.nodes;
            if (!nodes)
                return;
            haveCompletions = true;

            let root = nodes.root;
            let items = nodes.items;
            let [start, end, waiting] = getRows(context);

            if (context.message)
                nodes.message.textContent = context.message;
            nodes.message.style.display = context.message ? "block" : "none";
            nodes.waiting.style.display = waiting ? "block" : "none";
            nodes.up.style.opacity = "0";
            nodes.down.style.display = "none";

            for (let [i, row] in Iterator(context.getRows(start, end, this._doc)))
                nodes[i] = row;
            for (let [i, row] in array.iteritems(nodes)) {
                if (!row)
                    continue;
                let display = (i >= start && i < end);
                if (display && row.parentNode != items) {
                    do {
                        var next = nodes[++i];
                        if (next && next.parentNode != items)
                            next = null;
                    }
                    while (!next && i < end)
                    items.insertBefore(row, next);
                }
                else if (!display && row.parentNode == items)
                    items.removeChild(row);
            }
            if (context.items.length == 0)
                return;
            nodes.up.style.opacity = (start == 0) ? "0" : "1";
            if (end != context.items.length)
                nodes.down.style.display = "block";
            else
                nodes.up.style.display = "block";
            if (start == end) {
                nodes.up.style.display = "none";
                nodes.down.style.display = "none";
            }
        }, this);

        this._divNodes.noCompletions.style.display = haveCompletions ? "none" : "block";

        this._completionElements = util.evaluateXPath("//xhtml:div[@dactyl:highlight='CompItem']", this._doc);

        return true;
    },

    clear: function clear() { this.setItems(); this._doc.body.innerHTML = ""; },
    hide: function hide() { this._container.collapsed = true; },
    show: function show() { this._container.collapsed = false; },
    visible: function visible() !this._container.collapsed,

    reset: function () {
        this._startIndex = this._endIndex = this._selIndex = -1;
        this._div = null;
        this.selectItem(-1);
    },

    // if @param selectedItem is given, show the list and select that item
    setItems: function setItems(newItems, selectedItem) {
        if (this._selItem > -1)
            this._getCompletion(this._selItem).removeAttribute("selected");
        if (this._container.collapsed)
            this._minHeight = 0;
        this._startIndex = this._endIndex = this._selIndex = -1;
        this._items = newItems;
        this.reset();
        if (typeof selectedItem == "number") {
            this.selectItem(selectedItem);
            this.show();
        }
    },

    // select index, refill list if necessary
    selectItem: function selectItem(index) {
        //let now = Date.now();

        if (this._div == null)
            this._init();

        let sel = this._selIndex;
        let len = this._items.allItems.items.length;
        let newOffset = this._startIndex;
        let maxItems = options["maxitems"];
        let contextLines = Math.min(3, parseInt((maxItems - 1) / 2));

        if (index == -1 || index == null || index == len) { // wrapped around
            if (this._selIndex < 0)
                newOffset = 0;
            this._selIndex = -1;
            index = -1;
        }
        else {
            if (index <= this._startIndex + contextLines)
                newOffset = index - contextLines;
            if (index >= this._endIndex - contextLines)
                newOffset = index + contextLines - maxItems + 1;

            newOffset = Math.min(newOffset, len - maxItems);
            newOffset = Math.max(newOffset, 0);

            this._selIndex = index;
        }

        if (sel > -1)
            this._getCompletion(sel).removeAttribute("selected");
        this._fill(newOffset);
        if (index >= 0) {
            this._getCompletion(index).setAttribute("selected", "true");
            //this._getCompletion(index).scrollIntoView(false);
        }

        //if (index == 0)
        //    this.start = now;
        //if (index == Math.min(len - 1, 100))
        //    dactyl.dump({ time: Date.now() - this.start });
    },

    onEvent: function onEvent(event) false
}, {
    WAITING_MESSAGE: "Generating results..."
});

// vim: set fdm=marker sw=4 ts=4 et:
