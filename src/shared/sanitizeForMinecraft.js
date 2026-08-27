/**
 * Nettoyage des textes sortants vers Minecraft
 *
 * Discord et Minecraft ne rendent pas le même sous-ensemble d'Unicode. Certains
 * caractères sont *invisibles par conception* : ils ne servent qu'à piloter le
 * rendu du caractère précédent. Discord les honore silencieusement, la police de
 * Minecraft ne les connaît pas et affiche un carré à leur place.
 *
 * Cas concret : les badges de mode de jeu ajoutés aux pseudos Discord
 * (`[423] Pseudo ♻️`) se terminent par un sélecteur de variation U+FE0F. Le
 * badge lui-même s'affiche correctement en jeu, mais le sélecteur apparaît
 * comme un caractère cassé juste derrière.
 *
 * Le nettoyage est volontairement minimal : on retire uniquement ces caractères
 * invisibles, jamais de contenu visible. Un emoji reste un emoji.
 *
 * Les points de code sont écrits en séquences d'échappement : un caractère
 * invisible littéral dans le source serait indétectable à la relecture.
 *
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

/**
 * Caractères invisibles de formatage, sans équivalent rendu dans Minecraft :
 *
 * - U+FE0E / U+FE0F    sélecteurs de variation (présentation texte / emoji)
 * - U+200B → U+200D    espace sans chasse, antiliant, liant (séquences ZWJ)
 * - U+2060             liant de mots
 * - U+FEFF             espace insécable sans chasse (BOM)
 * - U+E0020 → U+E007F  caractères « tag » (séquences de drapeaux)
 * - U+E0100 → U+E01EF  sélecteurs de variation supplémentaires
 */
const INVISIBLE_FORMATTING =
	/[\uFE0E\uFE0F\u200B-\u200D\u2060\uFEFF]|[\u{E0020}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

/**
 * Retirer d'un texte les caractères invisibles que Minecraft rend en carrés.
 *
 * @param {string} text - Texte destiné au chat Minecraft (commande incluse)
 * @returns {string} Texte sans caractère de formatage invisible
 */
function sanitizeForMinecraft(text) {
	if (typeof text !== 'string') return text;

	return text.replace(INVISIBLE_FORMATTING, '');
}

module.exports = { sanitizeForMinecraft, INVISIBLE_FORMATTING };
