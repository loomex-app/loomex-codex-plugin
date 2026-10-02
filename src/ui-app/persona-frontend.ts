/** Routes match the frontend workspace router; the installation supplies its base. */
export function personaFrontendUrl(value:unknown,path:"persons"|"persona-roles"|"memory"):string {
  if(typeof value!=="string"||!value)throw new Error("The Loomex website address is not configured. Configure it to manage Personas, roles or memory.");
  let url:URL;try{url=new URL(value);}catch{throw new Error("The Loomex website address is invalid. Check your connection.");}
  if(!["https:","http:"].includes(url.protocol)||url.username||url.password)throw new Error("The Loomex website address is invalid. Check your connection.");
  url.pathname=`${url.pathname.replace(/\/$/,"")}/${path}`;url.search="";url.hash="";return url.href;
}
