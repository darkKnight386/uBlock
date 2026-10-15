/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2019-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock

*/

import { matchesStackTraceFn } from './stack-trace.js';
import { proxyApplyFn } from './proxy-apply.js';
import { registerScriptlet } from './base.js';
import { safeSelf } from './safe-self.js';

/******************************************************************************/

//  Split a space-separated list of object paths. A path can end with a value
//  filter, i.e. `a.b.[=].value`, in which case the property is considered
//  only if its value matches. `value` can be `true`, `false`, a number, a
//  string, or a `/regex/`. Spaces are allowed in a `/regex/` value.

function objectPathsFn(rawPaths) {
    if ( typeof rawPaths !== 'string' || rawPaths === '' ) { return []; }
    const safe = safeSelf();
    const marker = '.[=].';
    const tokens = rawPaths.match(/(?:\.\[=\]\.\/(?:[^/\\]|\\.)*\/[gimsu]*|\S)+/g) || [];
    return tokens.map(token => {
        const pos = token.indexOf(marker);
        if ( pos === -1 ) { return { path: token }; }
        const path = token.slice(0, pos);
        const raw = token.slice(pos + marker.length);
        let valueDetails;
        if ( raw === 'true' ) {
            valueDetails = { value: true };
        } else if ( raw === 'false' ) {
            valueDetails = { value: false };
        } else if ( /^\d+$/.test(raw) ) {
            valueDetails = { value: parseInt(raw, 10) };
        } else if ( /^\/.+\/[gimsu]*$/.test(raw) ) {
            const { re } = safe.initPattern(raw.replace(/[gimsu]*$/, m => m.replace(/g/g, '')));
            valueDetails = { re };
        } else {
            valueDetails = { value: raw };
        }
        return { path, valueDetails };
    });
}
registerScriptlet(objectPathsFn, {
    name: 'object-paths.fn',
    dependencies: [
        safeSelf,
    ],
});

/******************************************************************************/

function objectFindOwnerFn(
    root,
    path,
    prune = false,
    valueDetails = undefined
) {
    const safe = safeSelf();
    const matchesValue = v => {
        if ( valueDetails === undefined ) { return true; }
        if ( valueDetails.re === undefined ) {
            return v === valueDetails.value;
        }
        const t = typeof v;
        if ( t !== 'string' && t !== 'number' && t !== 'boolean' ) {
            return false;
        }
        return safe.RegExp_test(valueDetails.re, `${v}`);
    };
    let owner = root;
    let chain = path;
    for (;;) {
        if ( typeof owner !== 'object' || owner === null  ) { return false; }
        const pos = chain.indexOf('.');
        if ( pos === -1 ) {
            if ( prune === false ) {
                return safe.Object_hasOwn(owner, chain) &&
                    matchesValue(owner[chain]);
            }
            let modified = false;
            if ( chain === '*' ) {
                for ( const key in owner ) {
                    if ( safe.Object_hasOwn(owner, key) === false ) { continue; }
                    if ( matchesValue(owner[key]) === false ) { continue; }
                    delete owner[key];
                    modified = true;
                }
            } else if ( safe.Object_hasOwn(owner, chain) && matchesValue(owner[chain]) ) {
                delete owner[chain];
                modified = true;
            }
            return modified;
        }
        const prop = chain.slice(0, pos);
        const next = chain.slice(pos + 1);
        let found = false;
        if ( prop === '[-]' && Array.isArray(owner) ) {
            let i = owner.length;
            while ( i-- ) {
                if ( objectFindOwnerFn(owner[i], next, false, valueDetails) === false ) { continue; }
                owner.splice(i, 1);
                found = true;
            }
            return found;
        }
        if ( prop === '{-}' && owner instanceof Object ) {
            for ( const key of Object.keys(owner) ) {
                if ( objectFindOwnerFn(owner[key], next, false, valueDetails) === false ) { continue; }
                delete owner[key];
                found = true;
            }
            return found;
        }
        if (
            prop === '[]' && Array.isArray(owner) ||
            prop === '{}' && owner instanceof Object ||
            prop === '*' && owner instanceof Object
        ) {
            for ( const key of Object.keys(owner) ) {
                if ( objectFindOwnerFn(owner[key], next, prune, valueDetails) === false ) { continue; }
                found = true;
            }
            return found;
        }
        if ( safe.Object_hasOwn(owner, prop) === false ) { return false; }
        owner = owner[prop];
        chain = chain.slice(pos + 1);
    }
}
registerScriptlet(objectFindOwnerFn, {
    name: 'object-find-owner.fn',
    dependencies: [
        safeSelf,
    ],
});

/******************************************************************************/

//  When no "prune paths" argument is provided, the scriptlet is
//  used for logging purpose and the "needle paths" argument is
//  used to filter logging output.
//
//  https://github.com/uBlockOrigin/uBlock-issues/issues/1545
//  - Add support for "remove everything if needle matches" case

export function objectPruneFn(
    obj,
    rawPrunePaths,
    rawNeedlePaths,
    stackNeedleDetails = { matchAll: true },
    extraArgs = {}
) {
    if ( typeof rawPrunePaths !== 'string' ) { return; }
    const safe = safeSelf();
    const prunePaths = objectPathsFn(rawPrunePaths);
    const needlePaths = prunePaths.length !== 0
        ? objectPathsFn(rawNeedlePaths)
        : [];
    if ( stackNeedleDetails.matchAll !== true ) {
        if ( matchesStackTraceFn(stackNeedleDetails, extraArgs.logstack) === false ) {
            return;
        }
    }
    if ( objectPruneFn.mustProcess === undefined ) {
        objectPruneFn.mustProcess = (root, needlePaths) => {
            for ( const { path, valueDetails } of needlePaths ) {
                if ( objectFindOwnerFn(root, path, false, valueDetails) === false ) {
                    return false;
                }
            }
            return true;
        };
    }
    if ( prunePaths.length === 0 ) { return; }
    let outcome = 'nomatch';
    if ( objectPruneFn.mustProcess(obj, needlePaths) ) {
        for ( const { path, valueDetails } of prunePaths ) {
            if ( objectFindOwnerFn(obj, path, true, valueDetails) ) {
                outcome = 'match';
            }
        }
    }
    if ( outcome === 'match' ) { return obj; }
}
registerScriptlet(objectPruneFn, {
    name: 'object-prune.fn',
    dependencies: [
        matchesStackTraceFn,
        objectFindOwnerFn,
        objectPathsFn,
        safeSelf,
    ],
});

/******************************************************************************/

function trustedPruneInboundObject(
    entryPoint = '',
    argPos = '',
    rawPrunePaths = '',
    rawNeedlePaths = '',
    ...varargs
) {
    if ( entryPoint === '' ) { return; }
    let context = globalThis;
    let prop = entryPoint;
    for (;;) {
        const pos = prop.indexOf('.');
        if ( pos === -1 ) { break; }
        context = context[prop.slice(0, pos)];
        if ( context instanceof Object === false ) { return; }
        prop = prop.slice(pos+1);
    }
    if ( typeof context[prop] !== 'function' ) { return; }
    const argIndex = parseInt(argPos);
    if ( isNaN(argIndex) ) { return; }
    if ( argIndex < 1 ) { return; }
    const safe = safeSelf();
    const extraArgs = safe.parseVarargs(varargs);
    const needlePaths = [];
    needlePaths.push(...objectPathsFn(rawPrunePaths));
    needlePaths.push(...objectPathsFn(rawNeedlePaths));
    const stackNeedle = safe.initPattern(extraArgs.stackToMatch || '', { canNegate: true });
    const mustProcess = root => {
        for ( const { path, valueDetails } of needlePaths ) {
            if ( objectFindOwnerFn(root, path, false, valueDetails) === false ) {
                return false;
            }
        }
        return true;
    };
    context[prop] = new Proxy(context[prop], {
        apply: function(target, thisArg, args) {
            const targetArg = argIndex <= args.length
                ? args[argIndex-1]
                : undefined;
            if ( targetArg instanceof Object && mustProcess(targetArg) ) {
                let objBefore = targetArg;
                if ( extraArgs.dontOverwrite ) {
                    try {
                        objBefore = safe.JSON_parse(safe.JSON_stringify(targetArg));
                    } catch {
                        objBefore = undefined;
                    }
                }
                if ( objBefore !== undefined ) {
                    const objAfter = objectPruneFn(
                        objBefore,
                        rawPrunePaths,
                        rawNeedlePaths,
                        stackNeedle,
                        extraArgs
                    );
                    args[argIndex-1] = objAfter || objBefore;
                }
            }
            return Reflect.apply(target, thisArg, args);
        },
    });
}
registerScriptlet(trustedPruneInboundObject, {
    name: 'trusted-prune-inbound-object.js',
    requiresTrust: true,
    dependencies: [
        objectFindOwnerFn,
        objectPathsFn,
        objectPruneFn,
        safeSelf,
    ],
});

/******************************************************************************/

function trustedPruneOutboundObject(
    propChain = '',
    rawPrunePaths = '',
    rawNeedlePaths = '',
    ...varargs
) {
    if ( propChain === '' ) { return; }
    const safe = safeSelf();
    const extraArgs = safe.parseVarargs(varargs);
    proxyApplyFn(propChain, function(context) {
        const objBefore = context.reflect();
        if ( objBefore instanceof Object === false ) { return objBefore; }
        const objAfter = objectPruneFn(
            objBefore,
            rawPrunePaths,
            rawNeedlePaths,
            { matchAll: true },
            extraArgs
        );
        return objAfter || objBefore;
    });
}
registerScriptlet(trustedPruneOutboundObject, {
    name: 'trusted-prune-outbound-object.js',
    requiresTrust: true,
    dependencies: [
        objectPruneFn,
        proxyApplyFn,
        safeSelf,
    ],
});

/******************************************************************************/
