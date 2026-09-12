# Text To Speech Multilingual V2 API Documentation

> Generate content using the Text To Speech Multilingual V2 model

## Overview

This document describes how to use the Text To Speech Multilingual V2 model for content generation. The process consists of two steps:
1. Create a generation task
2. Query task status and results

## Authentication

All API requests require a Bearer Token in the request header:

```
Authorization: Bearer YOUR_API_KEY
```

Get API Key:
1. Visit [API Key Management Page](https://kie.ai/api-key) to get your API Key
2. Add to request header: `Authorization: Bearer YOUR_API_KEY`

---

## 1. Create Generation Task

### API Information
- **URL**: `POST https://api.kie.ai/api/v1/jobs/createTask`
- **Content-Type**: `application/json`

### Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| model | string | Yes | Model name, format: `elevenlabs/text-to-speech-multilingual-v2` |
| input | object | Yes | Input parameters object |
| callBackUrl | string | No | Callback URL for task completion notifications. If provided, the system will send POST requests to this URL when the task completes (success or fail). If not provided, no callback notifications will be sent. Example: `"https://your-domain.com/api/callback"` |

### Model Parameter

The `model` parameter specifies which AI model to use for content generation.

| Property | Value | Description |
|----------|-------|-------------|
| **Format** | `elevenlabs/text-to-speech-multilingual-v2` | The exact model identifier for this API |
| **Type** | string | Must be passed as a string value |
| **Required** | Yes | This parameter is mandatory for all requests |

> **Note**: The model parameter must match exactly as shown above. Different models have different capabilities and parameter requirements.

### Callback URL Parameter

The `callBackUrl` parameter allows you to receive automatic notifications when your task completes.

| Property | Value | Description |
|----------|-------|-------------|
| **Purpose** | Task completion notification | Receive real-time updates when your task finishes |
| **Method** | POST request | The system sends POST requests to your callback URL |
| **Timing** | When task completes | Notifications sent for both success and failure states |
| **Content** | Query Task API response | Callback content structure is identical to the Query Task API response |
| **Parameters** | Complete request data | The `param` field contains the complete Create Task request parameters, not just the input section |
| **Optional** | Yes | If not provided, no callback notifications will be sent |

**Important Notes:**
- The callback content structure is identical to the Query Task API response
- The `param` field contains the complete Create Task request parameters, not just the input section  
- If `callBackUrl` is not provided, no callback notifications will be sent

### input Object Parameters

#### text
- **Type**: `string`
- **Required**: Yes
- **Description**: The text to convert to speech
- **Max Length**: 5000 characters
- **Default Value**: `"Unlock powerful API with Kie.ai! Affordable, scalable APl integration, free trial playground, and secure, reliable performance."`

#### voice
- **Type**: `string`
- **Required**: No
- **Description**: The voice to use for speech generation
- **Options**:
  - `Rachel`: Rachel
  - `Aria`: Aria
  - `Roger`: Roger
  - `Sarah`: Sarah
  - `Laura`: Laura
  - `Charlie`: Charlie
  - `George`: George
  - `Callum`: Callum
  - `River`: River
  - `Liam`: Liam
  - `Charlotte`: Charlotte
  - `Alice`: Alice
  - `Matilda`: Matilda
  - `Will`: Will
  - `Jessica`: Jessica
  - `Eric`: Eric
  - `Chris`: Chris
  - `Brian`: Brian
  - `Daniel`: Daniel
  - `Lily`: Lily
  - `Bill`: Bill
  - `BIvP0GN1cAtSRTxNHnWS`: Ellen - Serious, Direct and Confident
  - `aMSt68OGf4xUZAnLpTU8`: Juniper - Grounded and Professional
  - `RILOU7YmBhvwJGDGjNmP`: Jane - Professional Audiobook Reader
  - `EkK5I93UQWFDigLMpZcX`: James - Husky, Engaging and Bold
  - `Z3R5wn05IrDiVCyEkUrK`: Arabella - Mysterious and Emotive
  - `tnSpp4vdxKPjI9w0GnoV`: Hope - upbeat and clear
  - `NNl6r8mD7vthiJatiJt1`: Bradford - Expressive and Articulate
  - `YOq2y2Up4RgXP2HyXjE5`: Xavier - Dominating, Metalic Announcer
  - `Bj9UqZbhQsanLzgalpEG`: Austin - Deep, Raspy and Authentic
  - `c6SfcYrb2t09NHXiT80T`: Jarnathan - Confident and Versatile
  - `B8gJV1IhpuegLxdpXFOE`: Kuon - Cheerful, Clear and Steady
  - `exsUS4vynmxd379XN4yO`: Blondie - Conversational
  - `BpjGufoPiobT79j2vtj4`: Priyanka - Calm, Neutral and Relaxed
  - `2zRM7PkgwBPiau2jvVXc`: Monika Sogam - Deep and Natural
  - `1SM7GgM6IMuvQlz2BwM3`: Mark - Casual, Relaxed and Light
  - `ouL9IsyrSnUkCmfnD02u`: Grimblewood Thornwhisker - Snarky Gnome & Magical Maintainer
  - `5l5f8iK3YPeGga21rQIX`: Adeline - Feminine and Conversational
  - `NOpBlnGInO9m6vDvFkFC`: Spuds Oxley - Wise and Approachable
  - `BZgkqPqms7Kj9ulSkVzn`: Eve - Authentic, Energetic and Happy
  - `wo6udizrrtpIxWGp2qJk`: Northern Terry
  - `yjJ45q8TVCrtMhEKurxY`: Dr. Von - Quirky, Mad Scientist
  - `gU0LNdkMOQCOrPrwtbee`: British Football Announce
  - `DGzg6RaUqxGRTHSBjfgF`: Brock - Commanding and Loud Sergeant
  - `DGTOOUoGpoP6UZ9uSWfA`: Célian - Documentary Narrator
  - `x70vRnQBMBu4FAYhjJbO`: Nathan – Virtual Radio Host
  - `P1bg08DkjqiVEzOn76yG`: Viraj - Rich and Soft
  - `qDuRKMlYmrm8trt5QyBn`: Taksh - Calm, Serious and Smooth
  - `kUUTqKQ05NMGulF08DDf`: Guadeloupe Merryweather - Emotional
  - `qXpMhyvQqiRxWQs4qSSB`: Horatius – Energetic Character Voice
  - `TX3LPaxmHKxFdv7VOQHJ`: Liam - Energetic, Social Media Creator
  - `iP95p4xoKVk53GoZ742B`: Chris - Charming, Down-to-Earth
  - `SOYHLrjzK2X1ezoPC6cr`: Harry - Fierce Warrior
  - `N2lVS1w4EtoT3dr4eOWO`: Callum - Husky Trickster
  - `FGY2WhTYpPnrIDTdsKH5`: Laura - Enthusiast, Quirky Attitude
  - `XB0fDUnXU5powFXDhCwa`: Charlotte
  - `cgSgspJ2msm6clMCkdW9`: Jessica - Playful, Bright, Warm
  - `MnUw1cSnpiLoLhpd3Hqp`: Heather Rey - Rushed and Friendly
  - `kPzsL2i3teMYv0FxEYQ6`: Brittney - Social Media Voice - Fun, Youthful & Informative
  - `UgBBYS2sOqTuMpoF3BR0`: Mark - Natural Conversations
  - `IjnA9kwZJHJ20Fp7Vmy6`: Matthew - Casual, Friendly and Smooth
  - `KoQQbl9zjAdLgKZjm8Ol`: Pro Narrator - Convincing story teller
  - `hpp4J3VqNfWAUOO0d1Us`: Bella - Professional, Bright, Warm
  - `pNInz6obpgDQGcFmaJgB`: Adam - Dominant, Firm
  - `nPczCjzI2devNBz1zQrb`: Brian - Deep, Resonant and Comforting
  - `L0Dsvb3SLTyegXwtm47J`: Archer
  - `uYXf8XasLslADfZ2MB4u`: Hope - Bubbly, Gossipy and Girly
  - `gs0tAILXbY5DNrJrsM6F`: Jeff - Classy, Resonating and Strong
  - `DTKMou8ccj1ZaWGBiotd`: Jamahal - Young, Vibrant, and Natural
  - `vBKc2FfBKJfcZNyEt1n6`: Finn - Youthful, Eager and Energetic
  - `TmNe0cCqkZBMwPWOd3RD`: Smith - Mellow, Spontaneous, and Bassy
  - `DYkrAHD8iwork3YSUBbs`: Tom - Conversations & Books
  - `56AoDkrOh6qfVPDXZ7Pt`: Cassidy - Crisp, Direct and Clear
  - `eR40ATw9ArzDf9h3v7t7`: Addison 2.0 - Australian Audiobook & Podcast
  - `g6xIsTj2HwM6VR4iXFCw`: Jessica Anne Bogart - Chatty and Friendly
  - `lcMyyd2HUfFzxdCaC4Ta`: Lucy - Fresh & Casual
  - `6aDn1KB0hjpdcocrUkmq`: Tiffany - Natural and Welcoming
  - `Sq93GQT4X1lKDXsQcixO`: Felix - Warm, positive & contemporary RP
  - `vfaqCOvlrKi4Zp7C2IAm`: Malyx - Echoey, Menacing and Deep Demon
  - `piI8Kku0DcvcL6TTSeQt`: Flicker - Cheerful Fairy & Sparkly Sweetness
  - `KTPVrSVAEUSJRClDzBw7`: Bob - Rugged and Warm Cowboy
  - `flHkNRp1BlvT73UL6gyz`: Jessica Anne Bogart - Eloquent Villain
  - `9yzdeviXkFddZ4Oz8Mok`: Lutz - Chuckling, Giggly and Cheerful
  - `pPdl9cQBQq4p6mRkZy2Z`: Emma - Adorable and Upbeat
  - `0SpgpJ4D3MpHCiWdyTg3`: Matthew Schmitz - Elitist, Arrogant, Conniving Tyrant
  - `UFO0Yv86wqRxAt1DmXUu`: Sarcastic and Sultry Villain
  - `oR4uRy4fHDUGGISL0Rev`: Myrrdin - Wise and Magical Narrator
  - `zYcjlYFOd3taleS0gkk3`: Edward - Loud, Confident and Cocky
  - `nzeAacJi50IvxcyDnMXa`: Marshal - Friendly, Funny Professor
  - `ruirxsoakN0GWmGNIo04`: John Morgan - Gritty, Rugged Cowboy
  - `1KFdM0QCwQn4rmn5nn9C`: Parasyte - Whispers from the Deep Dark
  - `TC0Zp7WVFzhA8zpTlRqV`: Aria - Sultry Villain
  - `ljo9gAlSqKOvF6D8sOsX`: Viking Bjorn - Epic Medieval Raider
  - `PPzYpIqttlTYA83688JI`: Pirate Marshal
  - `ZF6FPAbjXT4488VcRRnw`: Amelia - Enthusiastic and Expressive
  - `8JVbfL6oEdmuxKn5DK2C`: Johnny Kid - Serious and Calm Narrator
  - `iCrDUkL56s3C8sCRl7wb`: Hope - Poetic, Romantic and Captivating
  - `1hlpeD1ydbI2ow0Tt3EW`: Olivia - Smooth, Warm and Engaging
  - `wJqPPQ618aTW29mptyoc`: Ana Rita - Smooth, Expressive and Bright
  - `EiNlNiXeDU1pqqOPrYMO`: John Doe - Deep
  - `FUfBrNit0NNZAwb58KWH`: Angela - Conversational and Friendly
  - `4YYIPFl9wE5c4L2eu2Gb`: Burt Reynolds™ - Deep, Smooth and clear
  - `OYWwCdDHouzDwiZJWOOu`: David - Gruff Cowboy
  - `6F5Zhi321D3Oq7v1oNT4`: Hank - Deep and Engaging Narrator
  - `qNkzaJoHLLdpvgh5tISm`: Carter - Rich, Smooth and Rugged
  - `YXpFCvM1S3JbWEJhoskW`: Wyatt- Wise Rustic Cowboy
  - `9PVP7ENhDskL0KYHAKtD`: Jerry B. - Southern/Cowboy
  - `LG95yZDEHg6fCZdQjLqj`: Phil - Explosive, Passionate Announcer
  - `CeNX9CMwmxDxUF5Q2Inm`: Johnny Dynamite - Vintage Radio DJ
  - `st7NwhTPEzqo2riw7qWC`: Blondie - Radio Host"
  - `aD6riP1btT197c6dACmy`: Rachel M - Pro British Radio Presenter
  - `FF7KdobWPaiR0vkcALHF`: David - Movie Trailer Narrator
  - `mtrellq69YZsNwzUSyXh`: Rex Thunder - Deep N Tough
  - `dHd5gvgSOzSfduK4CvEg`: Ed - Late Night Announcer
  - `cTNP6ZM2mLTKj2BFhxEh`: Paul French - Podcaster
  - `eVItLK1UvXctxuaRV2Oq`: Jean - Alluring and Playful Femme Fatale
  - `U1Vk2oyatMdYs096Ety7`: Michael - Deep, Dark and Urban
  - `esy0r39YPLQjOczyOib8`: Britney - Calm and Calculative Villain
  - `bwCXcoVxWNYMlC6Esa8u`: Matthew Schmitz - Gravel, Deep Anti-Hero
  - `D2jw4N9m4xePLTQ3IHjU`: Ian - Strange and Distorted Alien
  - `Tsns2HvNFKfGiNjllgqo`: Sven - Emotional and Nice
  - `Atp5cNFg1Wj5gyKD7HWV`: Natasha - Gentle Meditation
  - `1cxc5c3E9K6F1wlqOJGV`: Emily - Gentile, Soft and Meditative
  - `1U02n4nD6AdIZ9CjF053`: Viraj - Smooth and Gentle
  - `HgyIHe81F3nXywNwkraY`: Nate - Sultry, Whispery and Seductive
  - `AeRdCCKzvd23BpJoofzx`: Nathaniel - Engaging, British and Calm
  - `LruHrtVF6PSyGItzMNHS`: Benjamin - Deep, Warm, Calming
  - `Qggl4b0xRMiqOwhPtVWT`: Clara - Relaxing, Calm and Soothing
  - `zA6D7RyKdc2EClouEMkP`: AImee - Tranquil ASMR and Meditation
  - `1wGbFxmAM3Fgw63G1zZJ`: Allison - Calm, Soothing and Meditative
  - `hqfrgApggtO1785R4Fsn`: Theodore HQ - Serene and Grounded
  - `sH0WdfE5fsKuM2otdQZr`: Koraly – Soft-spoken and Gentle
  - `MJ0RnG71ty4LH3dvNfSd`: Leon - Soothing and Grounded
  - `scOwDtmlUjD3prqpp97I`: Sam - Support Agent
  - `Sm1seazb4gs7RSlUVw7c`: Anika - Animated, Friendly and Engaging
- **Default Value**: `"BIvP0GN1cAtSRTxNHnWS"`

#### stability
- **Type**: `number`
- **Required**: No
- **Description**: Voice stability (0-1)
- **Range**: 0 - 1 (step: 0.01)
- **Default Value**: `0.5`

#### similarity_boost
- **Type**: `number`
- **Required**: No
- **Description**: Similarity boost (0-1)
- **Range**: 0 - 1 (step: 0.01)
- **Default Value**: `0.75`

#### style
- **Type**: `number`
- **Required**: No
- **Description**: Style exaggeration (0-1)
- **Range**: 0 - 1 (step: 0.01)
- **Default Value**: `0`

#### speed
- **Type**: `number`
- **Required**: No
- **Description**: Speech speed (0.7-1.2). Values below 1.0 slow down the speech, above 1.0 speed it up. Extreme values may affect quality.
- **Range**: 0.7 - 1.2 (step: 0.01)
- **Default Value**: `1`

#### timestamps
- **Type**: `boolean`
- **Required**: No
- **Description**: Whether to return timestamps for each word in the generated speech
- **Default Value**: `false`

#### previous_text
- **Type**: `string`
- **Required**: No
- **Description**: The text that came before the text of the current request. Can be used to improve the speech's continuity when concatenating together multiple generations or to influence the speech's continuity in the current generation.
- **Max Length**: 5000 characters
- **Default Value**: `""`

#### next_text
- **Type**: `string`
- **Required**: No
- **Description**: The text that comes after the text of the current request. Can be used to improve the speech's continuity when concatenating together multiple generations or to influence the speech's continuity in the current generation.
- **Max Length**: 5000 characters
- **Default Value**: `""`

#### language_code
- **Type**: `string`
- **Required**: No
- **Description**: Language code (ISO 639-1) used to enforce a language for the model. Currently only Turbo v2.5 and Flash v2.5 support language enforcement. For other models, an error will be returned if language code is provided.
- **Max Length**: 500 characters
- **Default Value**: `""`

### Request Example

```json
{
  "model": "elevenlabs/text-to-speech-multilingual-v2",
  "input": {
    "text": "Unlock powerful API with Kie.ai! Affordable, scalable APl integration, free trial playground, and secure, reliable performance.",
    "voice": "BIvP0GN1cAtSRTxNHnWS",
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 42,
    "speed": 1,
    "timestamps": false,
    "previous_text": "Enter your prompt here...",
    "next_text": "Enter your prompt here...",
    "language_code": ""
  }
}
```
### Response Example

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "taskId": "281e5b0*********************f39b9"
  }
}
```

### Response Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| code | integer | Response status code, 200 indicates success |
| msg | string | Response message |
| data.taskId | string | Task ID for querying task status |

---

## 2. Query Task Status

### API Information
- **URL**: `GET https://api.kie.ai/api/v1/jobs/recordInfo`
- **Parameter**: `taskId` (passed via URL parameter)

### Request Example
```
GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=281e5b0*********************f39b9
```

### Response Example

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "taskId": "281e5b0*********************f39b9",
    "model": "elevenlabs/text-to-speech-multilingual-v2",
    "state": "waiting",
    "param": "{\"model\":\"elevenlabs/text-to-speech-multilingual-v2\",\"input\":{\"text\":\"Unlock powerful API with Kie.ai! Affordable, scalable APl integration, free trial playground, and secure, reliable performance.\",\"voice\":\"BIvP0GN1cAtSRTxNHnWS\",\"stability\":0.5,\"similarity_boost\":0.75,\"style\":42,\"speed\":1,\"timestamps\":false,\"previous_text\":\"Enter your prompt here...\",\"next_text\":\"Enter your prompt here...\",\"language_code\":\"\"}}",
    "resultJson": "",
    "failCode": null,
    "failMsg": null,
    "costTime": null,
    "completeTime": null,
    "createTime": 1757584164490
  }
}
```

### Response Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| code | integer | Response status code, 200 indicates success |
| msg | string | Response message |
| data.taskId | string | Task ID |
| data.model | string | Model name used |
| data.state | string | Task status: `waiting`(waiting),  `success`(success), `fail`(fail) |
| data.param | string | Task parameters (JSON string) |
| data.resultJson | string | Task result (JSON string, available when task is success). Structure depends on outputMediaType: `{resultUrls: []}` for image/media/video, `{resultObject: {}}` for text |
| data.failCode | string | Failure code (available when task fails) |
| data.failMsg | string | Failure message (available when task fails) |
| data.costTime | integer | Task duration in milliseconds (available when task is success) |
| data.completeTime | integer | Completion timestamp (available when task is success) |
| data.createTime | integer | Creation timestamp |

---

## Usage Flow

1. **Create Task**: Call `POST https://api.kie.ai/api/v1/jobs/createTask` to create a generation task
2. **Get Task ID**: Extract `taskId` from the response
3. **Wait for Results**: 
   - If you provided a `callBackUrl`, wait for the callback notification
   - If no `callBackUrl`, poll status by calling `GET https://api.kie.ai/api/v1/jobs/recordInfo`
4. **Get Results**: When `state` is `success`, extract generation results from `resultJson`

## Error Codes

| Status Code | Description |
|-------------|-------------|
| 200 | Request successful |
| 400 | Invalid request parameters |
| 401 | Authentication failed, please check API Key |
| 402 | Insufficient account balance |
| 404 | Resource not found |
| 422 | Parameter validation failed |
| 429 | Request rate limit exceeded |
| 500 | Internal server error |

Pricing: ElevenLabs TTS Multilingual V2: 12 credits per 1,000 characters (≈ $0.06).