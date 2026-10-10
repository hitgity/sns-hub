// (선택) 브라우저에서 직접 유튜브 API를 부를 때만 쓰는 키. README 7번(깃허브 Actions 자동 갱신)을 켰다면 비워두세요.
// 여기 넣은 키는 공개되므로 쓸 경우 구글 클라우드에서 반드시 "웹사이트" 제한을 거세요.
window.YT_API_KEY = "AIzaSyB2IbRtK2HEbHT5V8eyycE0ZPQCwQxoTm4";

// 채널당 받아올 최근 영상 수 (1~20). '영상 조회순'은 이 안에서 정렬됩니다.
window.VIDEOS_PER_CHANNEL = 10;

// 캐시 유지 시간(분). 이 시간 안에 다시 열면 API를 다시 부르지 않습니다.
window.CACHE_MINUTES = 60;
