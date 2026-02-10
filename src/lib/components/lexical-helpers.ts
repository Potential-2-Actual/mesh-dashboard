import {
	createEditor as _createEditor,
	$getRoot,
	$getSelection,
	$isRangeSelection,
	$createParagraphNode,
	$createTextNode,
	KEY_ENTER_COMMAND,
	COMMAND_PRIORITY_HIGH,
	$isTextNode,
	TextNode
} from 'lexical';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { registerPlainText } from '@lexical/plain-text';

export {
	_createEditor as createEditor,
	$getRoot as getRoot,
	$getSelection as getSelection,
	$isRangeSelection as isRangeSelection,
	$createParagraphNode as createParagraphNode,
	$createTextNode as createTextNode,
	KEY_ENTER_COMMAND,
	COMMAND_PRIORITY_HIGH,
	$isTextNode as isTextNode,
	TextNode,
	CodeNode,
	CodeHighlightNode,
	registerPlainText
};
