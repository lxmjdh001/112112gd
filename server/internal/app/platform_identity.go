package app

import "regexp"

var telegramAccountID = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)
var lineAccountMID = regexp.MustCompile(`^u[0-9a-f]{32}$`)

func validBillingIdentity(platform, identifier string) bool {
	switch platform {
	case "whatsapp":
		return billingPhone.MatchString(identifier)
	case "telegram":
		return telegramAccountID.MatchString(identifier)
	case "line":
		return lineAccountMID.MatchString(identifier)
	default:
		return false
	}
}
