const path = require('path')
const util = require('util')
const binarySearch = require('binary-search')
const { protocol } = require('tera-data-parser')
const { hasPadding } = require('./integrity');
const log = require('../logger')

function* iterateHooks(globalHooks = [], codeHooks = []) {
    const globalHooksIterator = globalHooks[Symbol.iterator](); // .values()
    const codeHooksIterator = codeHooks[Symbol.iterator](); // .values()

    let nextGlobalHook = globalHooksIterator.next()
    let nextCodeHook = codeHooksIterator.next()

    while (!nextGlobalHook.done || !nextCodeHook.done) {
        const globalHookGroup = nextGlobalHook.value
        const codeHookGroup = nextCodeHook.value

        if (globalHookGroup && (!codeHookGroup || globalHookGroup.order <= codeHookGroup.order)) {
            yield* globalHookGroup.hooks
            nextGlobalHook = globalHooksIterator.next()
        } else {
            yield* codeHookGroup.hooks
            nextCodeHook = codeHooksIterator.next()
        }
    }
}

function getHookName(hook) {
    const callbackName = hook.callback ? (hook.callback.name || '(anonymous)') : '<unknown>'
    const moduleName = hook.moduleName || '<unknown>'
    return `${callbackName} in ${moduleName}`
}

function getMessageName(map, identifier, version, originalName) {
    if (typeof identifier === 'string') {
        const append = (identifier !== originalName) ? ` (original: "${originalName}")` : ''
        return `${identifier}<${version}>${append}`
    }

    if (typeof identifier === 'number') {
        const name = map.code.get(identifier) || `(opcode ${identifier})`
        return `${name}<${version}>`
    }

    return '(?)'
}

function parseStack(err) {
    const stack = (err && err.stack) || ''
    return stack.split('\n').slice(1).map((line) => {
        if (line.indexOf('(eval ') !== -1) {
            // throw away eval info
            // see <https://github.com/stacktracejs/error-stack-parser/blob/d9eb56a/error-stack-parser.js#L59>
            line = line.replace(/(\(eval at [^()]*)|(\),.*$)/g, '')
        }

        const match = line.match(/^\s*at (?:.+\s+\()?(?:(.+):\d+:\d+|([^)]+))\)?/)
        return match && {
            filename: match[2] || match[1],
            source: line,
        }
    }).filter(Boolean)
}

function errStack(err = new Error(), removeFront = true) {
    const stack = parseStack(err)
    const libPath = /tera-network-proxy[\\/]lib/

    // remove node internals from end
    while (stack.length > 0 && !path.isAbsolute(stack[stack.length - 1].filename)) {
        stack.pop()
    }

    // remove tera-network-proxy internals from end
    while (stack.length > 0 && libPath.test(stack[stack.length - 1].filename)) {
        stack.pop()
    }

    if (removeFront) {
        // remove tera-network-proxy internals from front
        while (stack.length > 0 && libPath.test(stack[0].filename)) {
            stack.shift()
        }
    }

    return stack.map(frame => frame.source).join('\n')
}

// -----------------------------------------------------------------------------

class Dispatch {
    constructor(connection) {
        this.connection = connection;

        // Initialize protocol maps
        this.protocolMap = {
            name: new Map(),
            code: new Map(),
            padding: (new Array(0x10000)).fill(false),
        };
        
        Object.keys(this.connection.metadata.maps.protocol).forEach(name => this.addOpcode(name, this.connection.metadata.maps.protocol[name], hasPadding(this.connection.metadata.protocolVersion, name)));

        // Initialize sysmsg maps
        this.sysmsgMap = {
            name: new Map(),
            code: new Map()
        };

        Object.keys(this.connection.metadata.maps.sysmsg).forEach(name => {
            this.sysmsgMap.name.set(name, this.connection.metadata.maps.sysmsg[name]);
            this.sysmsgMap.code.set(this.connection.metadata.maps.sysmsg[name], name);
        });

        // Initialize protocol
        this.protocol = new protocol(this.connection.metadata.majorPatchVersion, this.connection.metadata.minorPatchVersion, this.protocolMap, this.connection.metadata.platform);
        this.protocol.load(this.connection.metadata.dataFolder);

        this.latestDefVersion = new Map();
        if (this.protocol.messages) {
            for (const [name, defs] of this.protocol.messages) {
                this.latestDefVersion.set(name, Math.max(...defs.keys()));
            }
        }

        // Initialize hooks
        // hooks:
        // { <code>:
        //	 [ { <order>
        //		 , hooks:
        //			 [ { <name>, <code>, <definitionVersion>, <filter>, <order>, <moduleName>, <callback>, <resolvedIdentifier> }
        //			 ]
        //		 }
        //	 ]
        // }
        this.hooks = new Map();
    }

    destructor() {
        this.hooks.clear();
    }

    get protocolVersion() { return this.connection.metadata.protocolVersion; }

    parseSystemMessage(message) {
        if (message[0] !== '@') throw Error(`Invalid system message "${message}" (expected @)`)

        const tokens = message.split('\v'),
            id = tokens[0].substring(1),
            name = id.includes(':') ? id : this.sysmsgMap.code.get(parseInt(id))

        if (!name) throw Error(`Unmapped system message ${id} ("${message}")`)

        const data = {}

        for (let i = 2; i < tokens.length; i += 2) data[tokens[i - 1]] = tokens[i]

        return { id: name, tokens: data }
    }

    buildSystemMessage(message, data) {
        if (typeof message === 'string') message = { id: message, tokens: data }
        else {
            const type = message === null ? 'null' : typeof message

            if (type !== 'object') throw TypeError(`Expected object or string, got ${type}`)
            if (!message.id) throw Error('message.id is required')
        }

        const id = message.id.toString().includes(':') ? message.id : this.sysmsgMap.name.get(message.id)

        if (!id) throw Error(`Unknown system message "${message.id}"`)

        data = message.tokens

        let str = '@' + id

        for (let key in data) str += `\v${key}\v${data[key]}`

        return str
    }

    fromRaw(name, version, data) {
        return this.protocol.parse(this.protocol.resolveIdentifier(name, version), data);
    }

    toRaw(name, version, data) {
        return this.protocol.write(this.protocol.resolveIdentifier(name, version), data);
    }

    resolve(name, definitionVersion = '*') {
        return this.protocol.resolveIdentifier(name, definitionVersion);
    }

    createHook(moduleName, name, version, opts, cb) {
        // parse args
        if (typeof version !== 'number' && version !== '*' && version !== 'raw' && version !== 'event')
            throw TypeError(`[dispatch] [${moduleName}] hook: invalid version specified (${version})`);

        if (opts && typeof opts !== 'object') {
            cb = opts;
            opts = {};
        }

        if (typeof cb !== 'function')
            throw TypeError(`[dispatch] [${moduleName}] hook: last argument not a function (given: ${typeof cb})`);

        // retrieve opcode
        let code;
        let resolvedIdentifier;
        if (name === '*') {
            code = name;
            if (typeof version === 'number')
                throw TypeError(`[dispatch] [${moduleName}] hook: * hook must request version '*', 'raw', or 'event' (given: ${version})`);
        } else {
            // Check if opcode is mapped
            code = this.protocolMap.name.get(name);
            if (code === null || typeof code === 'undefined')
                throw Error(`[dispatch] [${moduleName}] hook: unmapped packet "${name}"`);

            // Check if definition exists / is deprecated
            if (version !== 'raw' && version !== 'event') {
                try {
                    resolvedIdentifier = this.resolve(name, version);
                    if (!resolvedIdentifier.definition.readable)
                        throw Error(`obsolete definition (${name}.${version})`);
                    else if (!resolvedIdentifier.definition.writeable)
                        log.warn(`[dispatch] [${moduleName}] hook: deprecated definition (${name}.${version}), mod might be broken!`);
                } catch (e) {
                    throw Error(`[dispatch] [${moduleName}] hook: ${e}`);
                }
            }
        }

        // create hook
        return {
            moduleName,
            code,
            filter: Object.assign({ fake: false, incoming: null, modified: null, silenced: false }, opts.filter),
            order: opts.order || 0,
            definitionVersion: version,
            callback: cb,
            name,
            resolvedIdentifier
        };
    }

    addHook(hook) {
        const { code, order } = hook;

        if (!this.hooks.has(code))
            this.hooks.set(code, []);

        const ordering = this.hooks.get(code);
        const index = binarySearch(ordering, { order }, (a, b) => a.order - b.order);
        if (index < 0) {
            // eslint-disable-next-line no-bitwise
            ordering.splice(~index, 0, { order, hooks: [hook] });
        } else {
            ordering[index].hooks.push(hook);
        }
    }

    hook(...args) {
        const hook = this.createHook(...args);
        this.addHook(hook);
        return hook;
    }

    unhook(hook) {
        if (!hook)
            return;

        if (!this.hooks.has(hook.code))
            return;

        const ordering = this.hooks.get(hook.code);
        const group = ordering.find(o => o.order === hook.order);
        if (group)
            group.hooks = group.hooks.filter(h => h !== hook);
    }

    unhookModule(name) {
        for (const orderings of this.hooks.values()) {
            for (const ordering of orderings)
                ordering.hooks = ordering.hooks.filter(hook => hook.moduleName !== name);
        }
    }

    write(outgoing, name, version, data) {
        if (!this.connection)
            return false

        if (Buffer.isBuffer(name)) {
            // Note: even though handle() doesn't modify the original buffer at all,
            // Note: we need to create a copy here because connection's sendServer()
            // Note: and sendClient() encrypt the buffer in-place.
            data = Buffer.from(name)
        } else {
            if (typeof version !== 'number' && typeof version !== 'string')
                throw new Error(`[dispatch] write: version is required`)

            if (version !== '*') {
                const latest = this.latestDefVersion.get(name)
                if (latest && version < latest) {
                    log.debug([
                        `[dispatch] write: ${getMessageName(this.protocolMap, name, version, name)} is not latest version (${latest})`,
                        errStack(),
                    ].join('\n'))
                }
            }

            try {
                data = this.protocol.write(this.protocol.resolveIdentifier(name, version), data)
            } catch (e) {
                throw new Error(`[dispatch] write: failed to generate ${getMessageName(this.protocolMap, name, version, name)}:\n${e}`);
            }
        }

        data = this.handle(data, !outgoing, true)
        if (data === false)
            return false

        this.connection[outgoing ? 'sendServer' : 'sendClient'](data)
        return true
    }

    handle(data, incoming, fake = false) {
        const code = data.readUInt16LE(2)

        const globalHooks = this.hooks.get('*')
        const codeHooks = this.hooks.get(code)
        if (!globalHooks && !codeHooks) return data

        let modified = false
        let silenced = false

        let eventCache = [],
            iter = 0,
            hooks = (globalHooks ? globalHooks.length : 0) + (codeHooks ? codeHooks.length : 0) // TODO bug

        for (const hook of iterateHooks(globalHooks, codeHooks)) {
            const lastHook = false; // quick workaround for bug above

            // check flags
            const { filter } = hook
            if (filter.fake !== null && filter.fake !== fake) continue
            if (filter.incoming !== null && filter.incoming !== incoming) continue
            if (filter.modified !== null && filter.modified !== modified) continue
            if (filter.silenced !== null && filter.silenced !== silenced) continue

            if (hook.definitionVersion === 'raw') {
                try {
                    const copy = Buffer.from(data)
                    Object.defineProperties(copy, {
                        $fake: { value: fake },
                        $incoming: { value: incoming },
                        $modified: { value: modified },
                        $silenced: { value: silenced },
                    })

                    const result = hook.callback(code, copy, incoming, fake)

                    if (Buffer.isBuffer(result)) {
                        if (result.length !== data.length || !result.equals(data)) {
                            modified = true
                            eventCache = []
                            data = result
                        }
                    } else if (typeof result === 'boolean') {
                        silenced = !result
                    }
                }
                catch (e) {
                    log.error([
                        `[dispatch] [${hook.moduleName}] handle: error running raw hook for ${getMessageName(this.protocolMap, code, hook.definitionVersion)}`,
                        `hook: ${getHookName(hook)}`,
                        `data: ${data.toString('hex')}`,
                        `error: ${e.message}`,
                        errStack(e),
                    ].join('\n'))
                }
            } else if (hook.definitionVersion === 'event') {
                try {
                    const result = hook.callback()

                    if (result === false)
                        silenced = true
                }
                catch (e) {
                    log.error([
                        `[dispatch] [${hook.moduleName}] handle: error running event hook for ${getMessageName(this.protocolMap, code, hook.definitionVersion)}`,
                        `hook: ${getHookName(hook)}`,
                        `error: ${e.message}`,
                        errStack(e),
                    ].join('\n'))
                }
            } else { // normal hook
                try {
                    const defVersion = hook.definitionVersion
                    const resolvedIdentifier = hook.resolvedIdentifier
                    let event = eventCache[defVersion] || (eventCache[defVersion] = this.protocol.parse(resolvedIdentifier, data))
                    if (!lastHook)
                        event = this.protocol.clone(resolvedIdentifier, event)

                    Object.defineProperties(event, {
                        $fake: { value: fake },
                        $incoming: { value: incoming },
                        $modified: { value: modified },
                        $silenced: { value: silenced },
                    })

                    try {
                        const result = hook.callback(event, fake)

                        if (result === true) {
                            eventCache = []

                            try {
                                data = this.protocol.write(resolvedIdentifier, event)

                                modified = true
                                silenced = false
                            } catch (e) {
                                log.error([
                                    `[dispatch] [${hook.moduleName}] handle: failed to generate ${getMessageName(this.protocolMap, code, defVersion)}`,
                                    `hook: ${getHookName(hook)}`,
                                    `error: ${e.message}`,
                                    errStack(e, false),
                                ].join('\n'))
                            }
                        }
                        else if (result === false)
                            silenced = true
                    }
                    catch (e) {
                        log.error([
                            `[dispatch] [${hook.moduleName}] handle: error running hook for ${getMessageName(this.protocolMap, code, defVersion)}`,
                            `hook: ${getHookName(hook)}`,
                            `data: ${util.inspect(event)}`,
                            `error: ${e.message}`,
                            errStack(e),
                        ].join('\n'))
                    }
                }
                catch (e) {
                    log.error([
                        `[dispatch] [${hook.moduleName}] handle: failed to parse ${getMessageName(this.protocolMap, code, hook.definitionVersion)}`,
                        `hook: ${getHookName(hook)}`,
                        `data: ${data.toString('hex')}`,
                        `error: ${e.message}`,
                        errStack(e, false),
                    ].join('\n'))
                }
            }
        }

        // return value
        return (!silenced ? data : false)
    }

    // Opcode / Definition management
    addOpcode(name, code, padding = false) {
        this.protocolMap.name.set(name, code);
        this.protocolMap.code.set(code, name);
        this.protocolMap.padding[code] = padding;
    }

    checkOpcodes(names) {
        return names.filter(name => !this.protocolMap.name.get(name));
    }

    addDefinition(name, version, definition, overwrite = false) {
        if (typeof definition === 'string')
            definition = this.protocol.parseDefinition(definition);
        this.protocol.addDefinition(name, version, definition, overwrite);

        if (!this.latestDefVersion.get(name) || this.latestDefVersion.get(name) < version)
            this.latestDefVersion.set(name, version);
    }

    checkDefinitions(defs) {
        let missingDefs = [];

        Object.entries(defs).forEach(([name, versions]) => {
            if (typeof versions !== 'object')
                versions = [versions];

            const known_versions = this.protocol.messages.get(name);
            versions.forEach(version => {
                if (version !== 'raw' && version !== 'event' && (!known_versions || !known_versions.get(version)))
                    missingDefs.push({ name, version });
            });
        });

        return missingDefs;
    }
}

module.exports = Dispatch;
