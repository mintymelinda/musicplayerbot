let headers = {
  'Client-ID': TWITCH_CLIENT_ID,
  'Authorization': `Bearer ${TWITCH_OAUTH_TOKEN}`,
  'Content-Type': 'application/json'
}

var session_id;
var videos = {};
var player;
var playing = false;
var MIN_VIEW_COUNT = 1;
var vetoCount = new Set()
var current_song_redeemer;

const SONG_REDEMPTION_PROMPT = 'Enter youtube id or song / artist name';
const SONG_REDEMPTION_TITLE = "Add a song request";
const SONG_REDEMPTION_COST = 10;
const SKIP_COST = 10000;
const SNOW_COST = 10;
const QUEUE_COST = 10;
const VETO_THRESHOLD = 3;
const VETO_COST = 10;
const VOLUME_INCREMENT = 5;
const MAX_TIMEOUT_TWTICH = 1209600;

class CustomRewards {
  constructor(rewards) {
    this.rewards = rewards;
  }

  async createChannelPointRedeems() {
    await fetch('https://api.twitch.tv/helix/channel_points/custom_rewards?' + new URLSearchParams({
      broadcaster_id: BROADCASTER_USER_ID,
      only_manegeable_rewards: true
    }), { headers: headers }
    ).then(r => r.json().then(async response => {
      for (var redeem of response?.data) {
        await fetch('https://api.twitch.tv/helix/channel_points/custom_rewards?' + new URLSearchParams({
          broadcaster_id: BROADCASTER_USER_ID,
          id: redeem.id
        }), { method: 'DELETE', headers: headers });
      }
    }));

    for (var reward of this.rewards) {
      await reward.createChannelPointRedeem();
    }
  }
}

class CustomReward {
  constructor(title, cost, user_input_required, prompt, skip_request_queue, response) {
    this.title = title;
    this.cost = cost;
    this.user_input_required = user_input_required;
    this.prompt = prompt;
    this.skip_request_queue = skip_request_queue;
    this.response = response;
  }

  async createChannelPointRedeem() {
    this.id = await fetch('https://api.twitch.tv/helix/channel_points/custom_rewards?' + new URLSearchParams({
      broadcaster_id: BROADCASTER_USER_ID
    }), {
      method: 'POST',
      body: JSON.stringify({
        title: this.title,
        cost: this.cost,
        is_user_input_required: this.user_input_required,
        prompt: this.prompt,
        should_redemptions_skip_request_queue: this.skip_request_queue
      }),
      headers: headers
    }).then(r => r.json().then(data => data.data[0].id));
  }
}

var custom_rewards = new CustomRewards([
  new CustomReward(SONG_REDEMPTION_TITLE, SONG_REDEMPTION_COST, true, SONG_REDEMPTION_PROMPT, true,
    async (event) => {
      playVideo(event, false)
    }),
  new CustomReward('Skip Song', SKIP_COST, false, undefined, false, skipSong),
  new CustomReward('Get current song', SNOW_COST, false, undefined, false,
    () => {
      if (playing) {
        sendMessage(`${player.getVideoData().title} - youtu.be/${player.getVideoData().video_id}`)
      } else {
        sendMessage(`Nothing playing samusShrug`)
      }
    }
  ),
  new CustomReward('Queue length', QUEUE_COST, false, undefined, false,
    () => {
      if (playing) {
        duration = time_remaining()
        getVideoList().forEach(x => duration = duration + x.ytData.duration)
        message = `There are ${getVideoList().length} songs in the queue [${durationString(duration)}]`

        if (getVideoList().length > 0) {
          message = message + ` Next song -> ${getVideoList()[0].ytData.title} [starts in ${durationString(player.getDuration() - player.getCurrentTime())}]`
        }
        sendMessage(message)
      } else {
        sendMessage(`Nothing in queue samusShrug`)
      }
    }
  ),
  new CustomReward('Vote to Skip', VETO_COST, false, undefined, false,
    (event) => {
      if (playing) {
        if (vetoCount.has(event.user_id)) {
          sendMessage(`${event.user_name} has already voted to skip.`)
        } else {
          vetoCount.add(event.user_id)

          if (vetoCount.size >= VETO_THRESHOLD) {
            skipSong()
          } else {
            sendMessage(`${vetoCount.size} out of ${VETO_THRESHOLD} needed to skip`)
          }
        }
      } else {
        sendMessage(`Nothing to skip samusShrug`)
      }
    }
  ),
  new CustomReward('Song request with video', 500, true, undefined, true,
    async (event) => {
      playVideo(event, true)
    }),
  new CustomReward('Quartz forgot to make it a video', 500, false, undefined, true,
    async (event) => {
      showVideo()
    }),
  new CustomReward('Volume UP', 30, false, "Mindy it's too QUIET please turn it up", true, () => change_volume(true)),
  new CustomReward('Volume DOWN', 30, false, "Mindy it's too LOUD please turn it down", true, () => change_volume(false)),
  new CustomReward('Timeout song requester for bad song', 25000, false, "Was it really that bad?", false, () => timeout_current_song_requester())
]);

function timeout_current_song_requester() {

  if (!playing) {
    sendMessage(`Nothing playing samusShrug`)
    return
  }

  // get the remaining duration
  var remaining_duration = parseInt(time_remaining())

  if (remaining_duration < 1) {
    return
  } else if (remaining_duration > MAX_TIMEOUT_TWTICH) {
    remaining_duration = MAX_TIMEOUT_TWTICH
  }
  // timeout user for the remaining duration of the current song
  timeout_user(current_song_redeemer, remaining_duration)

  // skip current song
  skipSong()
}

function timeout_user(id, remaining_duration) {
  fetch('https://api.twitch.tv/helix/moderation/bans?' + new URLSearchParams({
    broadcaster_id: BROADCASTER_USER_ID,
    moderator_id: BROADCASTER_USER_ID
  }), {
    method: 'POST',
    body: JSON.stringify({
      data: {
        user_id: id,
        duration: remaining_duration,
        reason: "Must have requested a really annoying song"
      }
    }),
    headers: headers
  })
}

function time_remaining() {
  return player.getDuration() - player.getCurrentTime()
}


function change_volume(up) {
  var volume = player.getVolume()
  if (up)
    volume = Math.min(100, volume + VOLUME_INCREMENT)
  else
    volume = Math.max(0, volume - VOLUME_INCREMENT)

  player.setVolume(volume)
  sendMessage("YouTube volume is " + volume + "%")
}

async function playVideo(event, show) {
  var ytData = await searchYouTube(event.user_input);
  for (var data of ytData) {
    if (data.isValid()) {
      var videoRequest = new VideoRequest(event, data, show);
      Object.defineProperty(videos, videoRequest.id, {
        enumerable: true,
        configurable: true,
        value: videoRequest
      });
      break;
    }
  }
}

function durationString(duration) {
  return `${(duration / 60).toFixed()}:${(duration % 60).toFixed().toString().padStart(2, '0')}`
}

function skipSong() {
  if (playing) {
    if (getVideoList().length > 0) {
      loadNextVideo();
    } else {
      player.stopVideo();
    }
    vetoCount.clear()
    sendMessage(`Successfully skipped samusSmelly`)
  } else {
    sendMessage(`Nothing playing samusShrug`)
  }
}

class YoutubeData {
  constructor(ytData) {
    this.videoId = ytData.id;
    this.title = ytData.snippet.title;
    this.thumbnail = ytData.snippet.thumbnails.standard;
    this.duration = this.YTDurationToSeconds(ytData.contentDetails.duration);
    this.licensedContent = ytData.contentDetails.licensedContent;
    this.viewCount = ytData.statistics.viewCount;
    this.liveBroadcastContent = ytData.snippet.liveBroadcastContent;
    this.categoryId = ytData.snippet.categoryId;
  }

  YTDurationToSeconds(duration) {
    var match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);

    match = match.slice(1).map(function (x) {
      if (x != null) {
        return x.replace(/\D/, '');
      }
    });

    var hours = (parseInt(match[0]) || 0);
    var minutes = (parseInt(match[1]) || 0);
    var seconds = (parseInt(match[2]) || 0);

    return hours * 3600 + minutes * 60 + seconds;
  }

  isValid() {
    return this.viewCount > MIN_VIEW_COUNT && this.liveBroadcastContent === "none";
  }
}

class VideoRequest {
  constructor(event, ytData, show) {
    this.id = event.id;
    this.rewardId = event.reward.id;
    this.redeemedAt = event.redeemed_at;
    this.user_id = event.user_id
    this.ytData = ytData;
    this.show = show;
  }
}

async function onYouTubeIframeAPIReady() {
  player = new YT.Player('player', {
    height: '720',
    width: '1280',
    videoId: '',
    playerVars: {
      'autoplay': 0,
      'controls': 0,
      'fs': 0,
      'rel': 0
    },
    events: {
      'onStateChange': onPlayerStateChange,
      'onReady': onPlayerReady
    }
  });
  await custom_rewards.createChannelPointRedeems();
  getWebSocket();
  hideVideo()
  update();
}

async function subscribeToEvent(type, condition) {
  return await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions`, {
    method: 'POST',
    body: JSON.stringify({
      type: type,
      version: '1',
      condition: condition,
      transport: {
        method: 'websocket',
        session_id: session_id
      }
    }),
    headers: headers
  }).then(r => r.json().then(x => x.data[0].id));
}

async function sendMessage(text) {
  await fetch('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    body: JSON.stringify({
      broadcaster_id: BROADCASTER_USER_ID,
      sender_id: BROADCASTER_USER_ID,
      message: text
    }),
    headers: headers
  });
}

async function searchYouTube(query) {
  var results = [];

  var yt = await youtubeQuery(query);
  if (yt) {
    results.push(yt);
  } else {
    var searchRegex = /(youtu.*be.*)\/(watch\?v=|embed\/|v|shorts|)(?<videoId>.*?((?=[&#?])|$))/.exec(query)?.groups['videoId'];
    if (searchRegex) {
      results.push(await youtubeQuery(searchRegex));
    } else {
      for (var key of YOUTUBE_API_KEYS) {
        var search = await fetch(`https://www.googleapis.com/youtube/v3/search?` + new URLSearchParams({
          part: `snippet`,
          q: query,
          type: `video`,
          key: key
        })).then(r => r.json());
        for (var r of search.items) {
          results.push(await youtubeQuery(r.id.videoId));
        }
        if (search.items.length > 0) {
          break;
        }
      }
    }
  }

  if (results.length == 0) {
    sendMessage(`Failed to find song for query: ${query}`)
  }

  return results;
}

async function youtubeQuery(videoId) {
  var data;
  for (var key of YOUTUBE_API_KEYS) {
    var q = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${key}`).then(r => r.json());
    if (q?.items?.length > 0) {
      data = new YoutubeData(q.items[0])
      break;
    }
  }
  return data;
}

function showVideo() {
  document.getElementById("player").style.display = "block"
}

function hideVideo() {
  document.getElementById("player").style.display = "none"
}

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.ENDED || event.data === YT.PlayerState.STOPPED || event.data === YT.PlayerState.CUED) {
    playing = false;
    hideVideo()
  }

  if (event.data === YT.PlayerState.PLAYING) {
    playing = true;
  }

  if (event.data == YT.PlayerState.BUFFERING) {
    event.target.setPlaybackQuality('small');
  }
}

function onPlayerReady(event) {
  event.target.setPlaybackQuality('small');
  event.target.setVolume(35);
}

function getVideoList() {
  return Object.values(videos);
}

function update() {
  if (!playing && getVideoList().length > 0) {
    loadNextVideo();
    vetoCount.clear()
  }

  setTimeout(() => update(), 900);
}

function loadNextVideo() {
  video = getVideoList()[0];

  current_song_redeemer = video.user_id

  console.log(`${video.ytData.videoId}`);
  player.loadVideoById(video.ytData.videoId);
  player.playVideo();
  if (video.show) {
    showVideo()
  }
  delete videos[video.id];

  console.log(videos);
}

async function getWebSocket() {
  var ws = new WebSocket("wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30");
  ws.onmessage = async (data) => {
    data = await JSON.parse(data.data.toString());
    switch (data.metadata.message_type) {
      case 'session_welcome':
        session_id = data.payload.session.id;
        for (var redeem of custom_rewards.rewards) {
          subscribeToEvent('channel.channel_points_custom_reward_redemption.add', {
            BROADCASTER_USER_ID: BROADCASTER_USER_ID,
            reward_id: redeem.id
          });
        }
        sendMessage('YouTube bot connected')
        break;
      case 'notification':
        console.log(data);
        switch (data.payload.subscription.type) {
          case 'channel.channel_points_custom_reward_redemption.add':
            var redeem = custom_rewards.rewards.find(x => x.id == data.payload.event.reward.id);
            await redeem?.response(data.payload.event);
            break;
        }
        break;
      case 'session_reconnect':
        console.log('session_reconnect');
        ws.close(200);
        ws = new WebSocket(data.payload.session.reconnect_url);
        break;
    }
  }
}