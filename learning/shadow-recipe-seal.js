// Immutable, content-addressed recipe closure for forward-shadow captures.
// A human-readable recipeVersion is an alias, never proof of unchanged terms.
import {
  SHADOW_RECIPE_SEAL_VERSION, canonicalDigest, deepFreeze, recipeError, recipeSealError, stableStringify,
} from './shadow-contracts.js';

export function sealShadowRecipe(recipe) {
  const err = recipeError(recipe); if (err) throw new Error(`shadow recipe seal: ${err}`);
  // Canonical JSON removes reference mutability and rejects non-JSON values.
  const frozenRecipe = JSON.parse(stableStringify(recipe));
  const seal = {
    sealVersion: SHADOW_RECIPE_SEAL_VERSION,
    recipeDigest: canonicalDigest({ sealVersion: SHADOW_RECIPE_SEAL_VERSION, recipe: frozenRecipe }),
    recipe: frozenRecipe,
  };
  const serr = recipeSealError(seal); if (serr) throw new Error(`shadow recipe seal: ${serr}`);
  return deepFreeze(seal);
}

export const sameShadowRecipe = (a, b) => a?.sealVersion === SHADOW_RECIPE_SEAL_VERSION
  && b?.sealVersion === SHADOW_RECIPE_SEAL_VERSION && a.recipeDigest === b.recipeDigest;
