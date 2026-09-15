import { useState, useRef } from "react";
import ModalUi from "../../primitives/ModalUi";
import { EmailBody } from "./EmailBody";
import {
  contractDocument,
  defaultMailBody,
  defaultMailSubject,
  sendEmailToSigners
} from "../../constant/Utils";
import { useTranslation } from "react-i18next";
import Loader from "../../primitives/Loader";
import { useNavigate } from "react-router";

const statusMap = {
  success: "success",
  "quota-reached": "quotareached",
};
function CustomizeMail(props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isCustomize, setIsCustomize] = useState(false);
  const [isReset, setIsReset] = useState(false);
  const [isLoader, setIsLoader] = useState(false);
  const sendingRef = useRef(false);

  const handleCloseSendmailModal = () => {
    if (props?.handleClose) {
      props?.handleClose();
      return;
    }
    props?.setIsMailModal(false);
    navigate("/report/1MwEuxLEkF");
  };

  const handleEmailSendToSigners = async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setIsLoader(true);
    let mailAttempted = false;
    try {
      if (typeof props?.beforeSend === "function") {
        await props.beforeSend();
      }
      const documentData = await contractDocument(props?.documentId);
      if (documentData && documentData?.length > 0) {
        if (typeof props?.beforeSend === "function" && !documentData[0]?.SignedUrl) {
          throw new Error(t("something-went-wrong-mssg"));
        }
        props?.setDocumentDetails && props?.setDocumentDetails(documentData[0]);
        if (
          documentData?.[0]?.SendinOrder &&
          documentData?.[0]?.SendinOrder === true
        ) {
          const ownerEmail = documentData[0].ExtUserPtr.Email;
          const ownerDetails = documentData[0].Signers.find(
            (x) => x.Email === ownerEmail
          );
          props?.setCurrUserId && props?.setCurrUserId(ownerDetails?.objectId);
        }
        const customMail = {
          body:
            props?.emailEditorType === "basic"
              ? props?.customizeMail?.body?.basic
              : props?.customizeMail?.body?.advanced,
          subject: props?.customizeMail?.subject
        };
        mailAttempted = true;
        const mailRes = await sendEmailToSigners(
          documentData,
          props?.signerList,
          customMail,
          props?.defaultMail,
          isCustomize,
        );
        props?.setIsMailModal(false);
        props?.setIsSend(true);
        props?.setMailStatus(statusMap[mailRes?.status] ?? "failed");
      } else {
        alert(t("something-went-wrong-mssg"));
      }
    } catch (err) {
      console.log("error", err);
      if (mailAttempted) {
        props?.setIsMailModal(false);
        props?.setIsSend(true);
        props?.setMailStatus("failed");
      } else {
        alert(err?.message || t("something-went-wrong-mssg"));
      }
    } finally {
      sendingRef.current = false;
      setIsLoader(false);
    }
  };

  const handleReset = () => {
    setIsReset(true);
    props?.setCustomizeMail({
      subject: defaultMailSubject,
      body: { basic: defaultMailBody, advanced: defaultMailBody }
    });
  };
  const onChangeSubject = (value) => {
    setIsReset(false);
    props?.setCustomizeMail((prev) => ({ ...prev, subject: value }));
  };

  const onChangeBody = (newValue, changedType) => {
    setIsReset(false);
    props?.setCustomizeMail((prev) => ({
      ...prev,
      body: { ...prev.body, [changedType]: newValue }
    }));
  };
  const handleSwitch = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const editor = props?.emailEditorType === "basic" ? "advanced" : "basic";
    props.setEmailEditorType(editor);
  };

  return (
    <>
      {isLoader ? (
        <div className="absolute w-full h-full flex justify-center items-center bg-black/30 rounded-box z-30">
          <Loader />
        </div>
      ) : (
        <ModalUi
          isOpen={props?.isMailModal}
          title={t("send-mail")}
          handleClose={() => handleCloseSendmailModal()}
        >
          <div className="max-h-96 overflow-y-scroll scroll-hide p-[20px] text-base-content">
            {!isCustomize && <span>{t("placeholder-alert-3")}</span>}
            {
                isCustomize && (
                  <>
                    <EmailBody
                      requestBody={props?.customizeMail?.body}
                      requestSubject={props?.customizeMail?.subject}
                      onChangeBody={onChangeBody}
                      onChangeSubject={onChangeSubject}
                      isReset={isReset}
                      handleSwitch={handleSwitch}
                      emailEditorType={props.emailEditorType}
                    />
                    <div
                      className="flex justify-end items-center gap-1 mt-2 op-link op-link-primary"
                      onClick={() => handleReset()}
                    >
                      <span>{t("reset-to-default")}</span>
                    </div>
                  </>
                )
            }
            <div className="flex flex-row items-center gap-2 md:gap-6 mt-2">
              <div className="flex flex-row gap-2">
                <button
                  onClick={() => handleEmailSendToSigners()}
                  disabled={isLoader}
                  className="op-btn op-btn-primary font-[500] text-sm shadow"
                >
                  {t("send")}
                </button>
                {isCustomize && (
                  <button
                    onClick={() => setIsCustomize(false)}
                    className="op-btn op-btn-ghost font-[500] text-sm"
                  >
                    {t("close")}
                  </button>
                )}
              </div>
              {
                  !isCustomize && (
                    <span
                      className="op-link op-link-accent text-sm"
                      onClick={() => setIsCustomize(true)}
                    >
                      {t("customize-email")}
                    </span>
                  )
              }
            </div>

            <div className="flex justify-center items-center mt-3">
              <span className="h-[1px] w-[20%] bg-[#ccc]"></span>
              <span className="ml-[5px] mr-[5px]">{t("or")}</span>
              <span className="h-[1px] w-[20%] bg-[#ccc]"></span>
            </div>
            <div className="my-3">{props?.handleShareList()}</div>
            <p id="copyUrl" ref={props?.copyUrlRef} className="hidden"></p>
          </div>
        </ModalUi>
      )}
    </>
  );
}

export default CustomizeMail;
