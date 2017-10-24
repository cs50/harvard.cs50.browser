define(function(require, exports, module) {
    main.consumes = [
        "c9", "commands", "dialog.error", "Editor", "editors", "fs", "layout",
        "MenuItem", "menus", "tabManager", "proc", "settings", "tree", "ui"
    ];
    main.provides = ["harvard.cs50.browser"];
    return main;

    function main(options, imports, register) {
        var c9 = imports.c9;
        var commands = imports.commands;
        var Editor = imports.Editor;
        var editors = imports.editors;
        var fs = imports.fs;
        var layout = imports.layout;
        var MenuItem = imports.MenuItem;
        var menus = imports.menus;
        var proc = imports.proc;
        var showError = imports["dialog.error"].show;
        var tabs = imports.tabManager;
        var settings = imports.settings;
        var tree = imports.tree;
        var ui = imports.ui;

        var _ = require("lodash");
        var basename = require("path").basename;
        var extname = require("path").extname;
        var join = require("path").join;

        var BROWSER_VER = 1;

        var extensions = ["db", "db3", "sqlite", "sqlite3"];
        var handle = editors.register("browser", "Browser", Browser, extensions);

        var cssInserted = false;
        handle.insertCss = function() {

            // ensure CSS is inserted only once
            if (cssInserted)
                return;

            cssInserted = true;
            ui.insertCss(require("text!./style.css"), options.staticPrefix, handle);
        }

        /**
         * adds Reload to tab context menu
         */
        handle.addReloadItem = function() {

            // add "Reload" item once
            if (handle.reloadAdded)
                return;

            // context menu of tab button
            handle.tabMenu = menus.get("context/tabs").menu;
            if (!handle.tabMenu)
                return;

            // create "Reload" item
            handle.reloadItem = new MenuItem({
                caption: "Reload",
                onclick: function() {
                    var tab = tabs.focussedTab;
                    if (tab.editorType === "browser")
                        tab.editor.reloadTab(tab);
                },
                visible: false
            });

            // add "Reload" item to context menu
            menus.addItemByPath("context/tabs/Reload", handle.reloadItem, 0, handle);
            handle.reloadAdded = true;

            // show "Reload" item only if tab is browser
            handle.tabMenu.on("prop.visible", function(e) {
                if (tabs.focussedTab.editorType === "browser" && e.value)
                    handle.reloadItem.show();
                else
                    handle.reloadItem.hide();
            });
        };

        /**
         * Toggles loading spinner
         */
        handle.toggleLoadingSpinner = function(container, tab, visible) {
            if (visible) {
                tab.classList.add("loading");
                container.classList.add("cs50-browser-loading");
            }
            else {
                tab.classList.remove("loading");
                container.classList.remove("cs50-browser-loading");
            }
        };

        /**
         * opens and reuses a Cloud9 tab for browser editor
         */
        function openBrowserTab(options, onClose) {
            tabs.open({
                name: options.name || "browser-tab",
                document: {
                    title: options.title || "browser",
                    browser: {
                        content: options.content,
                        path: options.path
                    }
                },
                editorType: "browser",
                active: true,
                focus: true,
            }, onClose || function() {});
        }

        // add c9 exec browser
        commands.addCommand({
            name: "browser",
            exec: function(args) {
                if (!_.isArray(args) || args.length !== 2 || !_.isString(args[1]))
                    return console.error("Usage: c9 exec browser path");

                // open phpliteadmin tab for database files
                if (extensions.indexOf(extname(args[1]).substring(1)) > -1) {

                    // join cwd and path only if path is relative
                    var path = args[1].startsWith("/")
                        ? args[1]
                        : join(args[0], args[1]);

                    return openBrowserTab({
                        name: "phpliteadmin-tab",
                        title: "phpliteadmin",
                        path: path
                    }, handleTabClose);
                }

                // open SPL programs in built-in browser tab
                fs.readFile(args[1], function(err, data) {
                    if (err)
                        throw err;

                    // remove shebang
                    data = data.replace(/^#!\/usr\/bin\/env browser\s*$/m, "");
                    openBrowserTab({
                        title: basename(args[1]),
                        content: data
                    });
                });
             }
        }, handle);

        // write ~/bin/browser to use in shebang
        var browserPath = "~/bin/browser";
        fs.exists(browserPath, function(exists) {
            var ver = settings.getNumber("project/cs50/simple/@browser");
            if (!exists || isNaN(ver) || ver < BROWSER_VER) {
                fs.writeFile(browserPath, require("text!./bin/browser"), function(err) {
                    if (err)
                        throw err;

                    fs.chmod(browserPath, 755, function(err) {
                        if (err)
                            throw err;

                        settings.set("project/cs50/simple/@browser", BROWSER_VER);
                    });
                });
            }
        });

        register(null, {
            "harvard.cs50.browser": handle
        });

        /**
         *  Opens files selected in file browser, ensuring browser
         * (re)uses a single tab
         */
        function openSelection(opts) {
            if (!c9.has(c9.STORAGE) || !tree.tree)
                return;

            var sel = tree.tree.selection.getSelectedNodes();
            var db = null;

            // get last selected db file, deselecting all db files temporarily
            sel.forEach(function(node) {
                if (node && node.path && extensions.indexOf(extname(node.path).substring(1)) > -1) {
                    db = node;
                    tree.tree.selection.unselectNode(db);
                }
            });

            // open non-db selected files (if any)
            if (sel.length > 0)
                tree.openSelection(opts);

            // open last selected db file, selecting it back
            if (db) {

                // just focus tab if phpliteadmin is running same db
                var tab = tabs.findTab("phpliteadmin-tab");
                if (tab && tab.document.lastState.browser.path === db.path)
                    return tabs.focusTab(tab);

                openBrowserTab({
                    name: "phpliteadmin-tab",
                    title: "phpliteadmin",
                    path: db.path.replace(/^\//, c9.workspaceDir + "/")
                }, handleTabClose);

                tree.tree.selection.selectNode(db, true);
            }
        }

        /**
         * Hooks event handler to kill phpliteadmin process associated with the
         * document currently open in tab, when tab is closed.
         */
        function handleTabClose(err, tab) {
            if (err)
                return console.error(err);

            // ensure handler hooked once
            tab.off("close", handleTabClose);

            // kill phpliteadmin when tab is closed
            tab.on("close", function() {
                var pid = tab.document.lastState.browser.pid;

                // process.kill isn't available after reload (bug?)
                if (pid)
                    proc.spawn("kill", { args: ["-1", pid ]}, function() {});
            });
        }

        /**
         * Spawns phpliteadmin and calls callback, passing in url, or error
         *
         * @param {string} path path of db file
         */
        function startPhpliteadmin(path, callback) {
            if (!path)
                return;

            // spawn phpliteadmin
            proc.spawn("phpliteadmin", {
                args: [ "--url-only", path ] },
                function(err, process) {
                if (err)
                    return callback(err);

                // keep running after reload
                process.unref();

                // get phpliteadmin url
                var data = "";
                process.stdout.on("data", function handleOutput(chunk) {
                    data += chunk;

                    var matches = data.match(/(https?:\/\/.+)\s/);
                    if (matches && matches[1]) {
                        process.stdout.off("data", handleOutput);
                        callback(null, matches[1], process.pid);
                    }
                });
            });
        }

        // hook new handler for Open to open db files
        tree.once("draw", function() {
            if (tree.tree) {
                tree.tree.off("afterChoose", tree.openSelection);
                tree.tree.on("afterChoose", openSelection);
            }
        });

        function Browser(){
            var plugin = new Editor("CS50", main.consumes, extensions);
            var emit = plugin.getEmitter();

            var container, iframe;
            var currDoc, currSession;
            var timeout;

            // draw editor
            plugin.on("draw", function(e) {

                // insert css
                handle.insertCss();

                // add "Reload" menu item to tab button context menu
                handle.addReloadItem();

                // create and style iframe
                iframe = document.createElement("iframe");
                iframe.style.background = "white";
                iframe.style.borderWidth = "0";
                iframe.style.display = "none";
                iframe.style.width = iframe.style.height = "100%";

                // remember container
                container = e.htmlNode;

                // append iframe
                container.appendChild(iframe);
            });

            /**
             * Reloads current built-in browser tab
             */
            function reloadTab(tab) {
                if (tab === currDoc.tab) {

                    // iframe.contentWindow.location.reload violates same-origin
                    if (currSession.url)
                        updateIframe({ url: iframe.src });
                    else if (currSession.content)
                        updateIframe({ content: currSession.content });
                }
            }

            function updateIframe(options) {

                // reset onload handler
                iframe.onload = function() {};

                // reset iframe src
                iframe.src = "about:blank";

                // hide iframe
                iframe.style.display = "none";

                if (!options)
                    return;

                // show loading spinner
                handle.toggleLoadingSpinner(container, currDoc.tab, true);

                // if url provided
                if (options.url) {
                    currSession.url = options.url;
                    iframe.src = options.url;
                }

                iframe.onload = function () {

                    // avoid triggering this infinitely
                    iframe.onload = function() {};

                    // if SPL program
                    if (options.content) {
                        currSession.content = options.content;
                        iframe.contentWindow.document.open();
                        iframe.contentWindow.document.write(options.content);
                        iframe.contentWindow.document.close();
                    }

                    // show iframe back
                    iframe.style.display = "initial";

                    // hide loading spinner
                    handle.toggleLoadingSpinner(container, currDoc.tab, false);
                }
            }

            plugin.on("documentLoad", function(e) {

                // reset iframe
                updateIframe();

                // set current document and session
                currDoc = e.doc;
                currSession = currDoc.getSession();

                // when content should be written to iframe
                plugin.on("contentSet", function(content) {
                    updateIframe({ content: content })
                });

                /**
                 * Toggles editor's theme based on current skin.
                 */
                function setTheme(e) {
                    if (!currDoc)
                        return;

                    // get document's tab
                    var tab = currDoc.tab;

                    // handle dark themes
                    if (e.theme.indexOf("dark") > -1) {

                        // change tab-button colors
                        container.style.backgroundColor = tab.backgroundColor = "#303130";
                        container.classList.add("dark");
                        tab.classList.add("dark");
                    }

                    // handle light themes
                    else {

                        // change tab-button colors
                        container.style.backgroundColor = tab.backgroundColor = "#f1f1f1";
                        container.classList.remove("dark");
                        tab.classList.remove("dark");
                    }
                }

                // toggle editor's theme when theme changes
                layout.on("themeChange", setTheme, currSession);

                // set editor's theme initially
                setTheme({ theme: settings.get("user/general/@skin") });
            });

            plugin.on("documentActivate", function(e) {

                // set current document and session
                currDoc = e.doc;
                currSession = currDoc.getSession();

                if (currSession.url && currSession.url !== iframe.src)
                    updateIframe({ url: currSession.url });
                else if (currSession.content)
                    updateIframe({ content: currSession.content });
            });

            // when path changes
            plugin.on("setState", function(e) {

                // reset and hide iframe
                updateIframe();

                // update current document and session
                currDoc = e.doc;
                currSession = currDoc.getSession();

                // set or update current db path
                currSession.path = e.state.path;

                // set or update current phpliteadmin pid
                if (e.state.pid) {
                    currSession.pid = e.state.pid;
                    handleTabClose(null, currDoc.tab);
                }

                // if phpliteadmin is already running, use url
                if (e.state.url) {
                    currSession.url = e.state.url;
                    updateIframe({ url: currSession.url });
                }

                // handle SDL programs
                else if (e.state.content) {
                    currSession.content = e.state.content;
                    emit("contentSet", currSession.content);
                }

                // handle database files
                else {

                    // show loading spinner
                    handle.toggleLoadingSpinner(container, currDoc.tab, true);

                    // refrain from updating iframe if we're starting another phpliteadmin
                    clearTimeout(timeout);
                    updateIframe();

                    // start phpliteadmin
                    startPhpliteadmin(currSession.path, function(err, url, pid) {
                        if (err)
                            return console.error(err);

                        // set or update session's url
                        currSession.url = url;

                        // set or update phpliteadmin pid
                        currSession.pid = pid;

                        // give chance to server to start
                        timeout = setTimeout(function() {

                            // reset iframe
                            updateIframe({ url: url });
                        }, 1000);
                    });
                }
            });

            // remember state between reloads
            plugin.on("getState", function(e) {
                e.state.content = e.doc.getSession().content;
                e.state.path = e.doc.getSession().path;
                e.state.pid = e.doc.getSession().pid;
                e.state.url = e.doc.getSession().url;
            });

            plugin.freezePublicAPI({
                reloadTab: reloadTab
            });

            plugin.load(null, "harvard.cs50.browser");

            return plugin;
        }
    }
});
