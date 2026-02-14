import {
	createEditor as _createEditor,
	$getRoot,
	$getSelection,
	$isRangeSelection,
	$createParagraphNode,
	$createTextNode,
	KEY_ENTER_COMMAND,
	KEY_BACKSPACE_COMMAND,
	COMMAND_PRIORITY_HIGH,
	$isTextNode,
	TextNode
} from 'lexical';
import { CodeNode, CodeHighlightNode, $createCodeNode, $isCodeNode } from '@lexical/code';
import { registerRichText } from '@lexical/rich-text';

export {
	_createEditor as createEditor,
	$getRoot as getRoot,
	$getSelection as getSelection,
	$isRangeSelection as isRangeSelection,
	$createParagraphNode as createParagraphNode,
	$createTextNode as createTextNode,
	KEY_ENTER_COMMAND,
	KEY_BACKSPACE_COMMAND,
	COMMAND_PRIORITY_HIGH,
	$isTextNode as isTextNode,
	TextNode,
	CodeNode,
	CodeHighlightNode,
	$createCodeNode as createCodeNode,
	$isCodeNode as isCodeNode,
	registerRichText
};
