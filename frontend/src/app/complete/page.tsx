
'use client'
import Head from "next/head";
import Image from "next/image";
import { Geist, Geist_Mono } from "next/font/google";
import styles from "@/styles/Home.module.css";
import TextButton from "@/components/TextButton";
import RootStyle from "@/components/RootStyle";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import StyledImage from "@/components/StyledImage";


export default function CompletePage() {
  const router = useRouter();

  // Prefetch routes this page navigates to
  useEffect(() => {
    router.prefetch('/')
  }, [router])
  return (
    <>
      <RootStyle>
        <div>
          <div className=" bg-latest-grey-200 p-5">
          <div  className='flex   items-center gap-3 max-w-[150px] mx-auto rounded-full bg-white  px-4 py-1'>
          <StyledImage src='/assets/svg/bridgeIcon.svg' alt='' className='h-5 w-5 ' />
          <p className=' font-bold text-20 '> BRIDGE</p>
          </div>
            <div className="bg-white rounded-md pb-[46px] mt-5 ">
              <div className="pt-10  flex items-center justify-center">
                <StyledImage src="/assets/svg/transactionComplete.svg" alt="" className="h-[56px] w-[56px]" />
              </div>
              <p className="text-center font-semibold text-md mt-5">
                Transaction completed
              </p>
            </div>
            <div className="bg-white rounded-md  mt-4 p-4">
              <div className="flex justify-between">
                <div>
                  <p className="text-14 font-semibold text-latest-grey-100">
                    From
                  </p>
                  <div className="flex  gap-2 mt-3">
                    <StyledImage src="/assets/svg/ethLogo.svg" alt="" className="h-6 w-6" />
                    <p className="text-16 font-medium text-latest-black-100  w-[106px]">
                      Polygon
                    </p>
                  </div>
                </div>
                <div>
                  <p className="text-14 font-semibold text-latest-grey-100">
                    To
                  </p>
                  <div className="flex  gap-2 mt-3">
                    <StyledImage src="/assets/svg/aztec.svg" alt="" className="h-6 w-6" />
                    <p className="text-16 font-medium text-latest-black-100  w-[106px]">
                      Aztec
                    </p>
                  </div>
                </div>
              </div>
              <hr className="text-latest-grey-300 my-3" />
              <p className="text-32 text-black font-medium text-center">
                1,99981 ETH
              </p>
              <p className="text-center text-16 font-medium text-latest-grey-500 mt-2">
                $2,192.99
              </p>
            </div>
            <div className="mt-4"></div>
          </div>
          <div className="bg-white rounded-md  px-5">
            <div className="py-4  ">
              <TextButton className="" onClick={()=>router.push('/')}>Back to Main Screen</TextButton>
            </div>
            <div className="flex   justify-center gap-2 pb-3">
              <StyledImage src="/assets/svg/silk0.4.svg" alt="" className="w-[14px] h-4" />
              <p className="text-12  font-medium text-latest-grey-600  ">
                Secured by Human Wallet
              </p>
            </div>
          </div>
        </div>
      </RootStyle>
    </>
  );
}