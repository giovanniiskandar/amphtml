/**
 * Copyright 2020 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Reassigns the trailing comments of a statement to be leading comment of its
 * next sibling. This is because JSDoc comments (which should be on the next
 * statement) get erroneously assigned as trailing comments of this statement.
 *
 * @interface {babel.PluginPass}
 * @return {babel.PluginObj}
 */
module.exports = function () {
  return {
    visitor: {
      Statement(path) {
        const {node} = path;
        const {trailingComments} = node;
        if (!trailingComments || trailingComments.length <= 0) {
          return;
        }

        // Babel NodePath definition is missing getNextSibling
        const next = /** @type {babel.NodePath}*/ (
          /** @type {*} */ (path).getNextSibling()
        );
        if (!next) {
          return;
        }

        node.trailingComments = null;
        next.addComments('leading', /** @type {*} */ (trailingComments));
      },
    },
  };
};
