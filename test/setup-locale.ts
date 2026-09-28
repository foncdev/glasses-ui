/**
 * 테스트 공통 준비. 기존 테스트는 한국어 화면을 기준으로 쓰였으므로 언어를
 * 한국어로 고정한다. 실행하는 기계의 언어(navigator.language)가 무엇이든
 * 결과가 같아야 한다. 영어 화면은 i18n 테스트가 setLocale('en')으로 따로 본다.
 */
import { setLocale } from '../src/core/i18n.js';

setLocale('ko');
