// Synthetic reference data. Facility names are used for realism only; all availability is invented.
const SPECS = ["Neurology","Cardiology","Orthopedics","Gastroenterology","Dermatology","Mental Health","Audiology","Podiatry","Optometry","Urology","Sleep Medicine","Pulmonology"];
const STD = s => s === "Mental Health" ? { wait: 20, drive: 30 } : { wait: 28, drive: 60 };
const A = arr => Object.fromEntries(SPECS.map((s, i) => [s, arr[i]]).filter(x => x[1] != null));

const CITY = {
  "Tampa":[27.95,-82.46],"Brandon":[27.94,-82.29],"St. Petersburg":[27.77,-82.64],"Clearwater":[27.97,-82.80],
  "Lakeland":[28.04,-81.95],"New Port Richey":[28.24,-82.72],"Brooksville":[28.56,-82.39],"Zephyrhills":[28.23,-82.18],
  "Sarasota":[27.34,-82.53],"Orlando":[28.54,-81.38],"Plant City":[28.02,-82.12],"Spring Hill":[28.48,-82.53],
  "Bradenton":[27.50,-82.57],"Wesley Chapel":[28.24,-82.33],"Sebring":[27.50,-81.44],"Ocala":[29.19,-82.14],"Riverview":[27.87,-82.33]
};

const VA_SITES = [
  { id:"TPA", name:"Tampa VAMC", full:"James A. Haley Veterans' Hospital", city:"Tampa", ll:[28.064,-82.427], home:true, avail:A([74,38,45,52,41,18,22,19,27,47,61,33]) },
  { id:"BPS", name:"Bay Pines VA", full:"C.W. Bill Young VA Medical Center", city:"Bay Pines", ll:[27.81,-82.78], avail:A([11,16,24,33,58,12,30,9,14,21,44,19]) },
  { id:"ORL", name:"Orlando VAMC", full:"Orlando VA Medical Center, Lake Nona", city:"Orlando", ll:[28.37,-81.27], avail:A([9,12,17,21,15,10,13,8,11,26,18,14]) },
  { id:"GNV", name:"Gainesville VAMC", full:"Malcom Randall VA Medical Center", city:"Gainesville", ll:[29.64,-82.34], avail:A([20,25,31,15,22,14,16,12,18,13,29,17]) },
  { id:"LKL", name:"Lakeland VA Clinic", full:"Lakeland VA Clinic", city:"Lakeland", ll:[28.03,-81.95], avail:A([null,null,null,null,34,26,15,11,20,null,null,null]) },
  { id:"NPR", name:"New Port Richey VA Clinic", full:"New Port Richey VA Clinic", city:"New Port Richey", ll:[28.25,-82.70], avail:A([null,30,null,null,null,16,19,14,9,null,null,null]) },
  { id:"SRQ", name:"Sarasota VA Clinic", full:"Sarasota VA Clinic", city:"Sarasota", ll:[27.33,-82.48], avail:A([null,null,null,null,27,13,12,7,16,null,null,null]) }
];

const CC_SITES = [
  ["cc1","Suncoast Neurology Group","Brandon",{"Neurology":6,"Sleep Medicine":12}],
  ["cc2","Bayside Heart & Vascular","St. Petersburg",{"Cardiology":8}],
  ["cc3","Hillsborough Orthopedic Associates","Tampa",{"Orthopedics":10}],
  ["cc4","Nature Coast GI","Brooksville",{"Gastroenterology":9}],
  ["cc5","Gulf Breeze Dermatology","Clearwater",{"Dermatology":7}],
  ["cc6","Polk Behavioral Health","Lakeland",{"Mental Health":5}],
  ["cc7","Pasco Hearing Center","Wesley Chapel",{"Audiology":4}],
  ["cc8","Tampa Bay Foot & Ankle","Tampa",{"Podiatry":6}],
  ["cc9","ClearView Eye Care","Plant City",{"Optometry":5}],
  ["cc10","West Coast Urology","Sarasota",{"Urology":11}],
  ["cc11","Restwell Sleep Center","Lakeland",{"Sleep Medicine":9}],
  ["cc12","Pinellas Pulmonary Partners","Clearwater",{"Pulmonology":10}],
  ["cc13","Heartland Neuro & Spine","Sebring",{"Neurology":14,"Orthopedics":12}],
  ["cc14","Manatee Mind & Wellness","Bradenton",{"Mental Health":7}],
  ["cc15","Hernando Heart Clinic","Spring Hill",{"Cardiology":13}],
  ["cc16","Sunrise Dermatology","Wesley Chapel",{"Dermatology":9}],
  ["cc17","Citrus Orthopedics","Ocala",{"Orthopedics":8,"Podiatry":5}],
  ["cc18","Lake Nona Gastro","Orlando",{"Gastroenterology":7}],
  ["cc19","Riverview Family Counseling","Riverview",{"Mental Health":4}],
  ["cc20","Brandon Urology Partners","Brandon",{"Urology":9}]
].map(([id,name,city,avail]) => ({ id, name, full:"Community care · "+city, city, ll:CITY[city], avail }));

const REASONS = {
  "Neurology":["New-onset tremor, evaluate","Chronic migraine not controlled","Peripheral neuropathy workup","Memory concerns, cognitive eval"],
  "Cardiology":["Abnormal stress test follow-up","New AFib, rate control","Chest pain with exertion","Murmur evaluation"],
  "Orthopedics":["Right knee OA, injection eval","Rotator cuff tear, surgical consult","Chronic low back pain","Hip pain, possible replacement"],
  "Gastroenterology":["Screening colonoscopy, positive FIT","GERD refractory to PPI","Elevated LFTs","Iron deficiency anemia workup"],
  "Dermatology":["Suspicious pigmented lesion","Psoriasis flare","Actinic keratoses, cryotherapy","Chronic eczema"],
  "Mental Health":["PTSD, start evidence-based therapy","Depression, medication management","Anxiety, new to care","Sleep and irritability after deployment"],
  "Audiology":["Hearing aid fitting","Tinnitus evaluation","Annual hearing test"],
  "Podiatry":["Diabetic foot exam","Plantar fasciitis","Ingrown toenail"],
  "Optometry":["Diabetic eye exam","Blurred vision, new glasses","Glaucoma suspect"],
  "Urology":["Elevated PSA","BPH symptoms","Kidney stone follow-up"],
  "Sleep Medicine":["Suspected sleep apnea, sleep study","CPAP intolerance"],
  "Pulmonology":["COPD management","Lung nodule on chest CT","Burn pit exposure, shortness of breath"]
};
const FIRST = ["James","Robert","Michael","William","David","Richard","Joseph","Thomas","Charles","Daniel","Anthony","Mark","Donald","Steven","Paul","Andre","Kenneth","Linda","Patricia","Barbara","Elizabeth","Jennifer","Maria","Susan","Margaret","Dorothy","Angela","Tanya","Keisha","Rosa","Carmen","Luis","Terrence","Hector","Darnell","Tuan","Gloria","Marcus","Wanda","Ray"];
const LAST = ["Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Thompson","White","Harris","Clark","Lewis","Robinson","Walker","Young","Allen","King","Wright","Scott","Torres","Nguyen","Hill","Flores","Green","Adams","Baker","Rivera","Mitchell","Carter","Okafor","Brennan","Delgado","Pruitt","Castillo"];
const CITYPOOL = ["Tampa","Tampa","Brandon","Riverview","St. Petersburg","Clearwater","Lakeland","Lakeland","New Port Richey","Brooksville","Zephyrhills","Sarasota","Plant City","Spring Hill","Bradenton","Wesley Chapel","Sebring"];
const PROV = ["Dr. A. Patel · PACT Blue","Dr. M. Okoye · PACT Gold","S. Ramirez, NP · PACT Green","Dr. L. Chen · PACT Red","Dr. R. Feldman · Mental Health","T. Brooks, PA · PACT Silver"];

function rng(seed){ return function(){ seed|=0; seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

module.exports = { SPECS, STD, CITY, VA_SITES, CC_SITES, ALL_SITES: [...VA_SITES, ...CC_SITES], REASONS, FIRST, LAST, CITYPOOL, PROV, rng };
